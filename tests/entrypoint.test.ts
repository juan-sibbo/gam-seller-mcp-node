import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { isEntrypoint } from "../src/entrypoint.js";

// Regression guard for the npx-launch bug: the package bin is a node_modules/.bin
// symlink, so process.argv[1] never equals import.meta.url by string — only by realpath.

describe("isEntrypoint — symlink-aware entry detection", () => {
  let tmp: string;
  let real: string;
  let link: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-entry-"));
    real = join(tmp, "server.js");
    link = join(tmp, "bin-link");
    writeFileSync(real, "// server");
    symlinkSync(real, link);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("treats a bin symlink pointing at the module as the entrypoint (the npx case)", () => {
    // moduleUrl = the real file; argv[1] = the symlink invoked by npx.
    expect(isEntrypoint(pathToFileURL(real).href, link)).toBe(true);
  });

  it("returns true when argv[1] is the real path itself", () => {
    expect(isEntrypoint(pathToFileURL(real).href, real)).toBe(true);
  });

  it("returns false when argv[1] points at a different file (imported, not run)", () => {
    const other = join(tmp, "other.js");
    writeFileSync(other, "// other");
    expect(isEntrypoint(pathToFileURL(real).href, other)).toBe(false);
  });

  it("returns false when argv[1] is undefined", () => {
    expect(isEntrypoint(pathToFileURL(real).href, undefined)).toBe(false);
  });

  it("returns false (never throws) when a path cannot be resolved", () => {
    expect(isEntrypoint(pathToFileURL(real).href, join(tmp, "missing"))).toBe(false);
  });
});
