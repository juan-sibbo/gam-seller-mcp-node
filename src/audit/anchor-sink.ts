import { isAbsolute, resolve } from "path";
import { pathToFileURL } from "url";
import { DEV_ANCHOR_PATH, type AnchorSink } from "./anchor.js";

// Operator-selectable anchor destination — the "flip a switch" seam for C-08 (issue #85).
// The external tamper-evidence store (WORM) is chosen at DEPLOY time by configuration, not baked
// into the code, so a deployment can move from the dev/local default to a real write-once store
// without a code change. Selected by the MCP_ANCHOR_SINK env var:
//
//   unset | "file"     → the bundled append-only local JSONL sink (dev / simulation default).
//   <module specifier> → dynamically import a custom AnchorSink (bring-your-own WORM backend).
//                        The module must export, as `default` or `createAnchorSink`, either an
//                        AnchorSink object or a factory (env) => AnchorSink. A path (absolute or
//                        relative to cwd) or a bare package specifier both work.
//
// Named built-in backends ("tsa", "s3") register their shortcuts here in later releases; each
// lazy-loads its own optional dependency via dynamic import, so the core package stays lean.
//
// Async by design: resolving a backend may need to import an optional dependency. Keeping the
// signature async now means adding those backends later never changes this contract.

export const ANCHOR_SINK_ENV = "MCP_ANCHOR_SINK";

export async function resolveAnchorSink(
  env: NodeJS.ProcessEnv = process.env
): Promise<AnchorSink | string> {
  const raw = env[ANCHOR_SINK_ENV]?.trim();

  // Default and explicit "file": the append-only local sink (HeadHashAnchor wraps a path).
  if (!raw || raw.toLowerCase() === "file") {
    return DEV_ANCHOR_PATH;
  }

  // Bring-your-own sink: import the module the operator pointed us at. A path is turned into a
  // file URL so an absolute/relative path works the same as a bare package specifier.
  const specifier = raw.startsWith(".") || isAbsolute(raw) ? pathToFileURL(resolve(raw)).href : raw;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(specifier)) as Record<string, unknown>;
  } catch (err) {
    // Fail closed: a misconfigured anchor destination must stop the boot, not silently fall back
    // to the local file (which would quietly weaken the tamper-evidence the operator asked for).
    throw new Error(
      `[anchor] ${ANCHOR_SINK_ENV}="${raw}": could not load the anchor sink module. ` +
        `Use "file" (default) or a path/specifier to a module exporting an AnchorSink. ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const exported = mod.default ?? mod.createAnchorSink;
  const sink =
    typeof exported === "function"
      ? (exported as (e: NodeJS.ProcessEnv) => AnchorSink)(env)
      : (exported as AnchorSink | undefined);

  if (!isAnchorSink(sink)) {
    throw new Error(
      `[anchor] ${ANCHOR_SINK_ENV}="${raw}": the module did not export a valid AnchorSink ` +
        `(needs append/readAll/isHealthy). Export a factory (env) => AnchorSink as \`default\`, ` +
        `or a \`createAnchorSink\` function.`
    );
  }
  return sink;
}

function isAnchorSink(v: unknown): v is AnchorSink {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as AnchorSink).append === "function" &&
    typeof (v as AnchorSink).readAll === "function" &&
    typeof (v as AnchorSink).isHealthy === "function"
  );
}
