import { realpathSync } from "fs";
import { fileURLToPath } from "url";

// True when this module's file is the process entrypoint.
//
// Resolves symlinks on both sides: when launched via the package bin (e.g. `npx
// gam-seller-mcp-node`), process.argv[1] is the node_modules/.bin symlink, not the real
// dist/server.js. A plain `import.meta.url === pathToFileURL(argv[1]).href` comparison
// fails to match in that case, so main() never runs and the server exits 0 without
// starting. realpathSync collapses the symlink so the two paths compare equal.
//
// Returns false (rather than throwing) if either path cannot be resolved — an unresolved
// entrypoint is simply "not a direct run", never a crash.
export function isEntrypoint(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}
