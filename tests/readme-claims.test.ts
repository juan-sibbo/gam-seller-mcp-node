import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { join } from "path";

// C-27 — README ↔ code parity (Carril A / threat T-8). The public README is the credential: a
// hostile reader must find NOTHING refutable against the code — in EITHER direction (over- OR
// under-claiming). This test pins the specific drift classes this project actually hit, so CI
// (the existing ci.yml vitest run) catches them instead of a human noticing weeks later. It is not
// a general NLP parity engine — it asserts a small set of checkable, high-value invariants.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const readme = readFileSync(join(repoRoot, "README.md"), "utf-8");

describe("README ↔ code parity (C-27 / T-8)", () => {
  it("every repo path referenced in the README exists (no dead references)", () => {
    // Markdown link targets + inline-code paths that look like repo files/dirs.
    const linkTargets = [...readme.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
    const codePaths = [...readme.matchAll(/`((?:src|tests|docs|config|scripts)\/[A-Za-z0-9_./-]+)`/g)].map((m) => m[1]);
    const topLevel = [...readme.matchAll(/`(CONTRIBUTING\.md|LICENSE|PRIVACY\.md|CHANGELOG\.md)`/g)].map((m) => m[1]);

    const candidates = [...linkTargets, ...codePaths, ...topLevel]
      .map((p) => p.split("#")[0].trim()) // drop anchor fragments
      .filter((p) => p && !/^https?:|^mailto:/.test(p))
      .filter((p) => /^(src|tests|docs|config|scripts)\//.test(p) || /\.(md|ts|json)$/.test(p) || p === "LICENSE");

    const missing = [...new Set(candidates)].filter((p) => !existsSync(join(repoRoot, p)));
    expect(missing, `README references paths that do not exist: ${missing.join(", ")}`).toEqual([]);
  });

  it("the MCP tool set matches between README and server.ts (both directions)", () => {
    const EXPECTED = ["well_known_capabilities", "discover_products", "get_forecast", "create_intent", "revoke_intent"].sort();

    // Every expected tool is named in the README.
    for (const tool of EXPECTED) {
      expect(readme.includes(tool), `README does not mention tool ${tool}`).toBe(true);
    }

    // The set the server actually registers == the expected set (catches an added/removed tool
    // that the README would not mention).
    const server = readFileSync(join(repoRoot, "src/server.ts"), "utf-8");
    const registered = [
      ...server.matchAll(/(?:guardedTool<[^>]*>|server\.tool)\s*\(\s*"([a-z_]+)"/g),
    ].map((m) => m[1]);
    expect([...new Set(registered)].sort()).toEqual(EXPECTED);
  });

  it("the anchor WORM backends the README claims are backed by real code", () => {
    // The re-sync (#96) claims append-only + selectable tsa/s3 backends via MCP_ANCHOR_SINK.
    expect(readme).toMatch(/MCP_ANCHOR_SINK/);
    expect(readme.toLowerCase()).toMatch(/\btsa\b/);
    expect(readme.toLowerCase()).toMatch(/object lock/);

    // …and each claim is real in the code, not just documented.
    expect(existsSync(join(repoRoot, "src/audit/anchor-tsa.ts"))).toBe(true);
    expect(existsSync(join(repoRoot, "src/audit/anchor-s3.ts"))).toBe(true);
    const sink = readFileSync(join(repoRoot, "src/audit/anchor-sink.ts"), "utf-8");
    expect(sink).toMatch(/"tsa"/);
    expect(sink).toMatch(/"s3"/);
  });

  it("the README does not claim a live GAM connection (forecast is synthetic until wired)", () => {
    // Guards the other direction: an over-claim that GAM is connected while the adapter is a stub.
    expect(readme.toLowerCase()).toMatch(/synthetic/);
    const source = readFileSync(join(repoRoot, "src/forecast/source.ts"), "utf-8");
    expect(source).toMatch(/not implemented/i); // GamForecastSource still throws
  });
});
