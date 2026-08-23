import { readFileSync, appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { dataPath } from "../config/paths.js";
import { DurabilityHealth } from "../durability.js";
import { AppendOnlyFileAnchorSink, DEV_ANCHOR_PATH, type AnchorRecord, type AnchorSink } from "./anchor.js";

// RFC 3161 timestamping AnchorSink (C-08, issue #85). Each anchored head-hash is submitted to a
// Time-Stamp Authority, which returns a signed timestamp token (TSR) attesting "this hash existed
// at this time". That token is third-party tamper-evidence: unlike a local file, the operator
// cannot forge it (it is signed by the TSA's key). No npm dependency — the TimeStampReq is a small
// fixed ASN.1 DER structure built by hand and POSTed with the built-in fetch; the opaque TSR bytes
// are stored for later offline verification (e.g. `openssl ts -verify`).
//
// Design: local-first, externalize-async. append() writes the record to an append-only local
// mirror synchronously (immediate durability + sync readAll); reconcile() does the network POST
// and stores the token. A record still lacking a token after a restart is re-queued on load, so a
// TSA outage or a crash mid-submit never drops the obligation to timestamp it.

const SHA256_OID_DER = Buffer.from([0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]);
const DER_NULL = Buffer.from([0x05, 0x00]);
const DER_BOOLEAN_TRUE = Buffer.from([0x01, 0x01, 0xff]);

function derLen(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  for (let n = len; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLen(value.length), value]);
}

// Build an RFC 3161 TimeStampReq for a SHA-256 digest (the head hash is already a SHA-256 hex
// string). Structure: SEQ { version INTEGER 1, messageImprint SEQ { SEQ { sha256-OID, NULL },
// OCTET STRING(digest) }, certReq BOOLEAN TRUE }.
export function buildTimeStampReq(headHashHex: string): Buffer {
  const digest = Buffer.from(headHashHex, "hex");
  const algId = der(0x30, Buffer.concat([SHA256_OID_DER, DER_NULL]));
  const messageImprint = der(0x30, Buffer.concat([algId, der(0x04, digest)]));
  const version = der(0x02, Buffer.from([0x01]));
  return der(0x30, Buffer.concat([version, messageImprint, DER_BOOLEAN_TRUE]));
}

function readLen(buf: Buffer, pos: number): { len: number; next: number } {
  let b = buf[pos++];
  if (b < 0x80) return { len: b, next: pos };
  const n = b & 0x7f;
  let len = 0;
  for (let k = 0; k < n; k++) len = (len << 8) | buf[pos++];
  return { len, next: pos };
}

// Minimal parse of the TimeStampResp status. Structure: SEQ { PKIStatusInfo SEQ { status INTEGER,
// ... }, timeStampToken OPTIONAL }. Granted = 0, grantedWithMods = 1; anything else is a rejection.
export function tsrStatus(tsr: Buffer): number {
  let pos = 0;
  if (tsr[pos++] !== 0x30) throw new Error("TSR: not a SEQUENCE");
  pos = readLen(tsr, pos).next;
  if (tsr[pos++] !== 0x30) throw new Error("TSR: no PKIStatusInfo");
  pos = readLen(tsr, pos).next;
  if (tsr[pos++] !== 0x02) throw new Error("TSR: no status INTEGER");
  const { len, next } = readLen(tsr, pos);
  pos = next;
  let status = 0;
  for (let k = 0; k < len; k++) status = (status << 8) | tsr[pos++];
  return status;
}

interface TokenLine {
  seq: number;
  head_hash: string;
  tsa_url: string;
  tsr_b64: string;
  obtained_at: string;
}

export interface TsaAnchorSinkConfig {
  tsaUrl: string;
  recordsPath?: string;
  tokensPath?: string;
  fetchImpl?: typeof fetch;
}

export class TsaAnchorSink implements AnchorSink {
  private readonly mirror: AppendOnlyFileAnchorSink;
  private readonly tsaUrl: string;
  private readonly tokensPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly durability = new DurabilityHealth("anchor-tsa", "TSA anchor tokens");
  private readonly tokenedSeqs = new Set<number>();
  private pending: AnchorRecord[] = [];

  constructor(cfg: TsaAnchorSinkConfig) {
    this.tsaUrl = cfg.tsaUrl;
    this.mirror = new AppendOnlyFileAnchorSink(cfg.recordsPath ?? DEV_ANCHOR_PATH);
    this.tokensPath = cfg.tokensPath ?? dataPath("anchor-tsa-tokens.jsonl");
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.loadTokens();
  }

  append(record: AnchorRecord): void {
    this.mirror.append(record); // sync local durability + readAll source
    this.pending.push(record); // queued for external timestamping in reconcile()
  }

  readAll(): AnchorRecord[] {
    const records = this.mirror.readAll();
    // Re-queue any record whose token is missing (fresh boot, or a crash mid-submit) so the
    // obligation to timestamp it survives a restart.
    this.pending = records.filter((r) => !this.tokenedSeqs.has(r.seq));
    return records;
  }

  isHealthy(): boolean {
    return this.mirror.isHealthy() && this.durability.isHealthy();
  }

  // POST each pending head-hash to the TSA and store the returned token. Idempotent: a record
  // already tokened is skipped; a failed submission is re-queued for the next cycle.
  async reconcile(): Promise<void> {
    const queue = this.pending;
    this.pending = [];
    const failed: AnchorRecord[] = [];
    for (const record of queue) {
      if (this.tokenedSeqs.has(record.seq)) continue;
      try {
        const tsr = await this.requestTimestamp(record.head_hash);
        this.storeToken(record, tsr);
        this.durability.markHealthy();
      } catch (err) {
        failed.push(record);
        this.durability.markDegraded(err);
      }
    }
    // Keep failures (and anything appended meanwhile) queued for the next reconcile.
    this.pending = [...failed, ...this.pending];
  }

  private async requestTimestamp(headHashHex: string): Promise<Buffer> {
    const der = buildTimeStampReq(headHashHex);
    // Copy into a fresh ArrayBuffer — an unambiguous BodyInit for the standard fetch type
    // (a Node Buffer / generic Uint8Array does not satisfy it under recent @types/node).
    const body = new ArrayBuffer(der.byteLength);
    new Uint8Array(body).set(der);
    const res = await this.fetchImpl(this.tsaUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/timestamp-query",
        Accept: "application/timestamp-reply",
      },
      body,
    });
    if (!res.ok) throw new Error(`TSA responded HTTP ${res.status}`);
    const tsr = Buffer.from(await res.arrayBuffer());
    const status = tsrStatus(tsr);
    if (status !== 0 && status !== 1) throw new Error(`TSA rejected the request (status ${status})`);
    return tsr;
  }

  private storeToken(record: AnchorRecord, tsr: Buffer): void {
    const line: TokenLine = {
      seq: record.seq,
      head_hash: record.head_hash,
      tsa_url: this.tsaUrl,
      tsr_b64: tsr.toString("base64"),
      obtained_at: new Date().toISOString(),
    };
    mkdirSync(dirname(this.tokensPath), { recursive: true });
    appendFileSync(this.tokensPath, JSON.stringify(line) + "\n", "utf-8");
    this.tokenedSeqs.add(record.seq);
  }

  private loadTokens(): void {
    let raw: string;
    try {
      raw = readFileSync(this.tokensPath, "utf-8");
    } catch {
      return; // no tokens yet
    }
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (t === "") continue;
      try {
        this.tokenedSeqs.add((JSON.parse(t) as TokenLine).seq);
      } catch {
        break; // torn trailing line
      }
    }
  }
}

// Construct a TSA sink from environment config. MCP_TSA_URL is required (fail closed if absent —
// selecting the TSA backend without a TSA endpoint is a misconfiguration, not a silent no-op).
export function createTsaAnchorSinkFromEnv(env: NodeJS.ProcessEnv = process.env): TsaAnchorSink {
  const tsaUrl = env.MCP_TSA_URL?.trim();
  if (!tsaUrl) {
    throw new Error(
      '[anchor] MCP_ANCHOR_SINK="tsa" requires MCP_TSA_URL (the RFC 3161 Time-Stamp Authority endpoint).'
    );
  }
  return new TsaAnchorSink({
    tsaUrl,
    recordsPath: env.MCP_ANCHOR_RECORDS_PATH?.trim() || undefined,
    tokensPath: env.MCP_TSA_TOKENS_PATH?.trim() || undefined,
  });
}
