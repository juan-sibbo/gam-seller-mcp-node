import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  TsaAnchorSink,
  buildTimeStampReq,
  tsrStatus,
} from "../src/audit/anchor-tsa.js";
import type { AnchorRecord } from "../src/audit/anchor.js";

// C-08 — RFC 3161 timestamping sink. No network in these tests: fetch is mocked and returns a
// canned TimeStampResp. Verifies the DER request, the local-first/externalize-async flow, token
// persistence, idempotency, and fail-and-requeue.

const HASH = "a".repeat(64); // a 32-byte SHA-256 digest in hex
const SHA256_OID = Buffer.from([0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]);

// Minimal valid TimeStampResp: SEQ { PKIStatusInfo SEQ { INTEGER status } }.
function tsr(status: number): Buffer {
  return Buffer.from([0x30, 0x05, 0x30, 0x03, 0x02, 0x01, status]);
}

function mockFetch(response: Buffer, opts: { ok?: boolean; status?: number } = {}) {
  return vi.fn(async (_url: string, _init: unknown) => ({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    arrayBuffer: async () => response.buffer.slice(response.byteOffset, response.byteOffset + response.byteLength),
  })) as unknown as typeof fetch;
}

const rec = (seq: number): AnchorRecord => ({ seq, head_hash: HASH, timestamp: new Date().toISOString() });

describe("TSA anchor sink — RFC 3161 (C-08)", () => {
  let dir: string;
  let recordsPath: string;
  let tokensPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "anchor-tsa-"));
    recordsPath = join(dir, "records.json");
    tokensPath = join(dir, "tokens.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("builds a well-formed TimeStampReq DER for a SHA-256 digest", () => {
    const req = buildTimeStampReq(HASH);
    expect(req[0]).toBe(0x30); // SEQUENCE
    expect(req.includes(SHA256_OID)).toBe(true); // sha256 algorithm identifier
    expect(req.includes(Buffer.from(HASH, "hex"))).toBe(true); // the 32-byte digest
  });

  it("parses the TimeStampResp status (granted vs rejected)", () => {
    expect(tsrStatus(tsr(0))).toBe(0);
    expect(tsrStatus(tsr(2))).toBe(2);
  });

  it("append is local-first: the record is durable and readable before any TSA call", () => {
    const fetchImpl = mockFetch(tsr(0));
    const sink = new TsaAnchorSink({ tsaUrl: "https://tsa.example/tsr", recordsPath, tokensPath, fetchImpl });
    sink.append(rec(0));
    expect(sink.readAll().map((r) => r.seq)).toEqual([0]);
    expect(fetchImpl).not.toHaveBeenCalled(); // no network on append
    expect(sink.isHealthy()).toBe(true);
  });

  it("reconcile POSTs the head-hash to the TSA and stores the token, idempotently", async () => {
    const fetchImpl = mockFetch(tsr(0));
    const sink = new TsaAnchorSink({ tsaUrl: "https://tsa.example/tsr", recordsPath, tokensPath, fetchImpl });
    sink.append(rec(0));
    await sink.reconcile();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://tsa.example/tsr");
    expect((init as { headers: Record<string, string> }).headers["Content-Type"]).toBe("application/timestamp-query");
    expect(Buffer.from((init as { body: Uint8Array }).body)[0]).toBe(0x30); // DER SEQUENCE
    expect(sink.isHealthy()).toBe(true);

    // Second reconcile must not re-POST an already-tokened record.
    await sink.reconcile();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a TSA failure flips health and re-queues; a later success stores the token", async () => {
    const failing = mockFetch(tsr(0), { ok: false, status: 503 });
    const sink = new TsaAnchorSink({ tsaUrl: "https://tsa.example/tsr", recordsPath, tokensPath, fetchImpl: failing });
    sink.append(rec(0));
    await sink.reconcile();
    expect(sink.isHealthy()).toBe(false);
    expect(failing).toHaveBeenCalledTimes(1);

    // Swap in a working TSA and reconcile again — the re-queued record gets tokened.
    (sink as unknown as { fetchImpl: typeof fetch }).fetchImpl = mockFetch(tsr(0));
    await sink.reconcile();
    expect(sink.isHealthy()).toBe(true);
  });

  it("a rejection status (not granted) is treated as a failure", async () => {
    const rejecting = mockFetch(tsr(2)); // 2 = rejection
    const sink = new TsaAnchorSink({ tsaUrl: "https://tsa.example/tsr", recordsPath, tokensPath, fetchImpl: rejecting });
    sink.append(rec(0));
    await sink.reconcile();
    expect(sink.isHealthy()).toBe(false);
  });

  it("does not re-timestamp records already tokened in a previous run (survives reload)", async () => {
    const first = new TsaAnchorSink({ tsaUrl: "https://tsa.example/tsr", recordsPath, tokensPath, fetchImpl: mockFetch(tsr(0)) });
    first.append(rec(0));
    await first.reconcile();

    // A fresh sink over the same files reloads the records AND the tokens → no re-POST needed.
    const reloadFetch = mockFetch(tsr(0));
    const second = new TsaAnchorSink({ tsaUrl: "https://tsa.example/tsr", recordsPath, tokensPath, fetchImpl: reloadFetch });
    expect(second.readAll().map((r) => r.seq)).toEqual([0]);
    await second.reconcile();
    expect(reloadFetch).not.toHaveBeenCalled();
  });
});
