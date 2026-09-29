import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFile, type ChildProcess } from "child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { randomUUID } from "crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// End-to-end regression for the reported incident: an operator command run against a LIVE node
// (the documented `docker compose exec … issue-buyer-token`) lost the token-issuance audit event
// and bricked the next boot with head_hash_mismatch. Real processes, real files: the node, the
// operator CLIs and a second node all share one state directory, as containers share a volume.

const ROOT = resolve(__dirname, "..");
const TSX = ["--import", "tsx"];
const PORT = 39_000 + Math.floor(Math.random() * 1_000);

let dataDir: string;
let keysDir: string;
let env: NodeJS.ProcessEnv;
const running: ChildProcess[] = [];

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(script: string, args: string[]): Promise<Run> {
  return new Promise((done) => {
    execFile(process.execPath, [...TSX, join(ROOT, script), ...args], { env, cwd: ROOT }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      done({ code, stdout, stderr });
    });
  });
}

function startNode(port: number): { child: ChildProcess; exited: Promise<number>; log: () => string } {
  let log = "";
  const child = spawn(process.execPath, [...TSX, join(ROOT, "src/server.ts"), "--http"], {
    env: { ...env, MCP_HTTP_PORT: String(port) },
    cwd: ROOT,
  });
  child.stderr?.on("data", (d) => (log += String(d)));
  running.push(child);
  const exited = new Promise<number>((done) => child.on("exit", (code) => done(code ?? -1)));
  return { child, exited, log: () => log };
}

async function waitHealthy(port: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("node did not become healthy");
}

// One audited buyer call (authentication + scope resolution land in the ledger).
async function buyerTraffic(port: number, token: string): Promise<void> {
  const client = new Client({ name: "e2e-buyer", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  const res = await client.callTool({ name: "discover_products", arguments: { token, client_request_id: randomUUID() } });
  await client.close();
  if (res.isError) throw new Error(`discover_products failed: ${JSON.stringify(res.content)}`);
}

const ledgerPath = () => join(dataDir, "audit-ledger.json");
const leasePath = () => join(dataDir, ".owner.lease");
const issuanceCount = () =>
  (JSON.parse(readFileSync(ledgerPath(), "utf-8")).entries as Array<{ event_class: string }>).filter(
    (e) => e.event_class === "token_issuance"
  ).length;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lease-e2e-data-"));
  keysDir = mkdtempSync(join(tmpdir(), "lease-e2e-keys-"));
  env = { ...process.env, MCP_DATA_DIR: dataDir, MCP_KEYS_DIR: keysDir, MCP_HTTP_HOST: "127.0.0.1" };
});

afterAll(() => {
  for (const child of running) if (child.exitCode === null) child.kill("SIGKILL");
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(keysDir, { recursive: true, force: true });
});

describe("operator commands vs a live node (owner lease, end to end)", () => {
  it("refuses state writes while the node runs, and stop → write → start boots clean", async () => {
    // Before the node exists: the operator can mint (pilot.sh flow).
    const first = await run("scripts/issue-buyer-token.ts", ["pilot-buyer-001"]);
    expect(first.code).toBe(0);
    expect(first.stdout.trim().split(".")).toHaveLength(3);
    expect(existsSync(leasePath())).toBe(false);

    const node = startNode(PORT);
    await waitHealthy(PORT);
    const ledgerBefore = readFileSync(ledgerPath(), "utf-8");

    // The reported incident: minting against the live node. Now refused before touching disk.
    const refused = await run("src/admin/cli.ts", ["issue-token", "pilot-buyer-002"]);
    expect(refused.code).toBe(3);
    expect(refused.stderr).toMatch(/REFUSED .*owned by another process \(server/);
    expect(refused.stdout).toBe("");

    // Same guard for revocation and DSR (both were ignored or undone by a live node).
    const revoke = await run("src/admin/cli.ts", ["revoke-token", first.stdout.trim()]);
    expect(revoke.code).toBe(3);
    const dsr = await run("src/dsr/cli.ts", ["restrict", "pilot-buyer-001"]);
    expect(dsr.code).toBe(3);

    // A second node on the same volume is refused too (would corrupt the chain the same way).
    const second = startNode(PORT + 1);
    expect(await second.exited).toBe(1);
    expect(second.log()).toMatch(/owned by another process/);

    expect(readFileSync(ledgerPath(), "utf-8")).toBe(ledgerBefore);

    // Graceful stop releases ownership (SIGTERM = `docker compose stop`).
    node.child.kill("SIGTERM");
    expect(await node.exited).toBe(0);
    expect(existsSync(leasePath())).toBe(false);

    // Stop → write → start: the documented procedure.
    const minted = await run("src/admin/cli.ts", ["issue-token", "pilot-buyer-002"]);
    expect(minted.code).toBe(0);

    const restarted = startNode(PORT + 2);
    await waitHealthy(PORT + 2);
    expect(restarted.log()).toMatch(/Ledger integrity verified on startup/);
    expect(issuanceCount()).toBe(2);

    // Restart after real buyer traffic, no operator command in between: the tail after the last
    // anchor is legitimate, so the node must boot (it used to fail head_hash_mismatch here).
    await buyerTraffic(PORT + 2, first.stdout.trim());
    restarted.child.kill("SIGTERM");
    expect(await restarted.exited).toBe(0);

    const afterTraffic = startNode(PORT + 3);
    await waitHealthy(PORT + 3);
    expect(afterTraffic.log()).toMatch(/Ledger integrity verified on startup/);
    afterTraffic.child.kill("SIGTERM");
    expect(await afterTraffic.exited).toBe(0);
  }, 90_000);
});
