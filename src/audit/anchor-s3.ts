import { readFileSync, appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { dataPath } from "../config/paths.js";
import { DurabilityHealth } from "../durability.js";
import { AppendOnlyFileAnchorSink, DEV_ANCHOR_PATH, type AnchorRecord, type AnchorSink } from "./anchor.js";

// S3 Object Lock timestamping AnchorSink (C-08, issue #85). Each anchored head-hash is written as
// its own object to a bucket with Object Lock in COMPLIANCE mode + a retain-until date. In that
// mode an object cannot be overwritten or deleted until the retention expires — NOT EVEN BY THE
// ACCOUNT ROOT — so the operator cannot rewrite anchor history. That external immutability is what
// makes the anchor tamper-evident against the operator (T-1); AWS enforces it, not us.
//
// The AWS SDK is an OPTIONAL dependency, imported dynamically only by the env factory when the s3
// backend is actually selected, so the core package stays lean (3 deps). This sink itself depends
// only on an abstract S3ObjectPutter, so it is fully testable without the SDK or a real bucket.
//
// Same local-first, externalize-async flow as the TSA sink: append() writes an append-only local
// mirror synchronously; reconcile() PUTs pending records to S3 and records them in a local
// manifest so a restart never re-PUTs an object already locked (nor drops one still pending).

// Default Object Lock window. Anchors survive ledger purge indefinitely (a head hash without its
// ledger is not personal data), so a long immutability window is appropriate. Configurable.
export const DEFAULT_S3_RETENTION_DAYS = 3650; // ~10 years

export interface S3ObjectPutter {
  // Put an object under Object Lock, immutable until `retainUntil`. Implementations map this to a
  // single PutObject with ObjectLockMode + ObjectLockRetainUntilDate.
  put(key: string, body: string, retainUntil: Date): Promise<void>;
}

interface ManifestLine {
  seq: number;
  head_hash: string;
  key: string;
  retain_until: string;
  put_at: string;
}

export interface S3AnchorSinkConfig {
  putter: S3ObjectPutter;
  keyPrefix?: string;
  retentionDays?: number;
  recordsPath?: string;
  manifestPath?: string;
  now?: () => Date;
}

export class S3ObjectLockAnchorSink implements AnchorSink {
  private readonly mirror: AppendOnlyFileAnchorSink;
  private readonly putter: S3ObjectPutter;
  private readonly keyPrefix: string;
  private readonly retentionDays: number;
  private readonly manifestPath: string;
  private readonly now: () => Date;
  private readonly durability = new DurabilityHealth("anchor-s3", "S3 anchor objects");
  private readonly putSeqs = new Set<number>();
  private pending: AnchorRecord[] = [];

  constructor(cfg: S3AnchorSinkConfig) {
    this.putter = cfg.putter;
    this.keyPrefix = cfg.keyPrefix ?? "anchors/";
    this.retentionDays = cfg.retentionDays ?? DEFAULT_S3_RETENTION_DAYS;
    this.mirror = new AppendOnlyFileAnchorSink(cfg.recordsPath ?? DEV_ANCHOR_PATH);
    this.manifestPath = cfg.manifestPath ?? dataPath("anchor-s3-manifest.jsonl");
    this.now = cfg.now ?? (() => new Date());
    this.loadManifest();
  }

  append(record: AnchorRecord): void {
    this.mirror.append(record); // sync local durability + readAll source
    this.pending.push(record); // queued for the S3 PUT in reconcile()
  }

  readAll(): AnchorRecord[] {
    const records = this.mirror.readAll();
    this.pending = records.filter((r) => !this.putSeqs.has(r.seq));
    return records;
  }

  isHealthy(): boolean {
    return this.mirror.isHealthy() && this.durability.isHealthy();
  }

  async reconcile(): Promise<void> {
    const queue = this.pending;
    this.pending = [];
    const failed: AnchorRecord[] = [];
    for (const record of queue) {
      if (this.putSeqs.has(record.seq)) continue;
      try {
        const key = `${this.keyPrefix}${record.seq}-${record.head_hash}.json`;
        const retainUntil = new Date(this.now().getTime() + this.retentionDays * 24 * 60 * 60 * 1000);
        await this.putter.put(key, JSON.stringify(record), retainUntil);
        this.recordPut(record, key, retainUntil);
        this.durability.markHealthy();
      } catch (err) {
        failed.push(record);
        this.durability.markDegraded(err);
      }
    }
    this.pending = [...failed, ...this.pending];
  }

  private recordPut(record: AnchorRecord, key: string, retainUntil: Date): void {
    const line: ManifestLine = {
      seq: record.seq,
      head_hash: record.head_hash,
      key,
      retain_until: retainUntil.toISOString(),
      put_at: this.now().toISOString(),
    };
    mkdirSync(dirname(this.manifestPath), { recursive: true });
    appendFileSync(this.manifestPath, JSON.stringify(line) + "\n", "utf-8");
    this.putSeqs.add(record.seq);
  }

  private loadManifest(): void {
    let raw: string;
    try {
      raw = readFileSync(this.manifestPath, "utf-8");
    } catch {
      return; // nothing put yet
    }
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (t === "") continue;
      try {
        this.putSeqs.add((JSON.parse(t) as ManifestLine).seq);
      } catch {
        break; // torn trailing line
      }
    }
  }
}

// Construct an S3 sink from environment config. MCP_S3_BUCKET is required (fail closed if absent).
// The AWS SDK is imported dynamically here — the ONLY place — so it stays an optional dependency:
// a deployment that does not select the s3 backend never needs it installed.
export async function createS3AnchorSinkFromEnv(
  env: NodeJS.ProcessEnv = process.env
): Promise<S3ObjectLockAnchorSink> {
  const bucket = env.MCP_S3_BUCKET?.trim();
  if (!bucket) {
    throw new Error('[anchor] MCP_ANCHOR_SINK="s3" requires MCP_S3_BUCKET (the Object Lock bucket).');
  }
  const region = env.MCP_S3_REGION?.trim() || env.AWS_REGION?.trim();
  const mode = (env.MCP_S3_OBJECT_LOCK_MODE?.trim() || "COMPLIANCE").toUpperCase();

  // Optional dependency: not a runtime import literal, so tsc/core install never require it.
  const sdkSpecifier: string = "@aws-sdk/client-s3";
  let sdk: { S3Client: new (o: unknown) => { send: (c: unknown) => Promise<unknown> }; PutObjectCommand: new (i: unknown) => unknown };
  try {
    sdk = (await import(sdkSpecifier)) as typeof sdk;
  } catch {
    throw new Error(
      '[anchor] MCP_ANCHOR_SINK="s3" needs the optional dependency @aws-sdk/client-s3. ' +
        "Install it in your deployment: npm i @aws-sdk/client-s3"
    );
  }
  const { S3Client, PutObjectCommand } = sdk;
  const client = new S3Client({ region });

  const putter: S3ObjectPutter = {
    async put(key, body, retainUntil) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: "application/json",
          ObjectLockMode: mode,
          ObjectLockRetainUntilDate: retainUntil,
        })
      );
    },
  };

  return new S3ObjectLockAnchorSink({
    putter,
    keyPrefix: env.MCP_S3_PREFIX?.trim() || undefined,
    retentionDays: env.MCP_S3_RETENTION_DAYS ? Number(env.MCP_S3_RETENTION_DAYS) : undefined,
  });
}
