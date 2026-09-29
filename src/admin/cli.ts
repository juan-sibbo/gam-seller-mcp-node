#!/usr/bin/env node
// Operator CLI — every command that writes the node's persistent state, behind one entry point.
//
// Shipped as the `gam-seller-admin` bin (and on PATH in the container image), so a publisher who
// runs the node from npm or Docker can mint/revoke buyer tokens and service data-subject requests
// without a source checkout. The dev wrappers in scripts/ and the `gam-seller-dsr` bin delegate
// here, so there is one implementation.
//
// Usage:
//   gam-seller-admin issue-token <buyer_id>                     → token on stdout (jti/exp on stderr)
//   gam-seller-admin revoke-token <token>                       → revoke by token (jti+exp from claims)
//   gam-seller-admin revoke-token --jti <jti> <expiresAtUnixMs> → revoke by jti
//   gam-seller-admin dsr <export|restrict|unrestrict|suppress> <buyer_id>   (see src/dsr/cli.ts)
//
// Every command runs as the single state owner (src/owner-lease.ts): if the node is running, the
// command is REFUSED before touching any store (exit 3). Running it against a live node used to
// lose the write silently — or brick the next boot (head_hash_mismatch). Stop the node, run the
// command, start the node:
//   docker compose stop seller-mcp-node
//   docker compose run --rm seller-mcp-node gam-seller-admin issue-token <buyer_id>
//   docker compose start seller-mcp-node

import { decodeJwt } from "jose";
import { runAsStateOwner, EXIT_STATE_OWNED } from "../owner-lease.js";
import { issueBuyerToken, revokeBuyerToken } from "../identity/token-cli.js";
import { runDsrCli, dsrArgsValid } from "../dsr/cli.js";
import { isEntrypoint } from "../entrypoint.js";

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export { EXIT_STATE_OWNED };

export interface AdminCliOptions {
  out?: (line: string) => void;
  err?: (line: string) => void;
}

const USAGE =
  "Usage: gam-seller-admin issue-token <buyer_id>\n" +
  "       gam-seller-admin revoke-token <token>\n" +
  "       gam-seller-admin revoke-token --jti <jti> <expiresAtUnixMs>\n" +
  "       gam-seller-admin dsr <export|restrict|unrestrict|suppress> <buyer_id>\n";

type Action = () => Promise<number> | number;

interface RevokeTarget {
  jti: string;
  expiresAtMs: number;
  buyerId?: string;
}

// Parse revoke-token arguments. Returns a string on a usage/claims error.
function parseRevoke(args: string[]): RevokeTarget | string {
  if (args[0] === "--jti") {
    const [, jti, expStr] = args;
    const expiresAtMs = Number(expStr);
    if (!jti || !expStr || !Number.isFinite(expiresAtMs)) return USAGE;
    return { jti, expiresAtMs };
  }
  if (!args[0]) return USAGE;
  let payload: ReturnType<typeof decodeJwt>;
  try {
    payload = decodeJwt(args[0]);
  } catch {
    return "[revoke] not a JWT — pass the token, or --jti <jti> <expiresAtUnixMs>\n";
  }
  if (typeof payload.jti !== "string" || typeof payload.exp !== "number") {
    return "[revoke] token has no jti/exp claim — cannot revoke\n";
  }
  return {
    jti: payload.jti,
    expiresAtMs: payload.exp * 1000,
    buyerId: typeof payload.sub === "string" ? payload.sub : undefined,
  };
}

// Resolve argv to an action WITHOUT touching disk, so a usage error never takes the lease.
function resolveAction(argv: string[], out: (l: string) => void, err: (l: string) => void): Action | string {
  const [command, ...args] = argv;
  switch (command) {
    case "issue-token": {
      const [buyerId] = args;
      if (!buyerId) return USAGE;
      return async () => {
        const issued = await issueBuyerToken(buyerId);
        out(issued.token + "\n");
        err(`[issue] buyer_id=${buyerId} jti=${issued.jti} aud=${issued.aud} exp=${new Date(issued.exp * 1000).toISOString()}\n`);
        return EXIT_OK;
      };
    }
    case "revoke-token": {
      const target = parseRevoke(args);
      if (typeof target === "string") return target;
      return () => {
        const revoked = revokeBuyerToken(target.jti, target.expiresAtMs, target.buyerId);
        err(
          `[revoke] jti=${revoked.jti} revoked until ${new Date(revoked.expiresAtMs).toISOString()} ` +
            `(denylist size=${revoked.denylistSize})\n`
        );
        return EXIT_OK;
      };
    }
    case "dsr":
      if (!dsrArgsValid(args)) return USAGE;
      return () => runDsrCli(args, { out, err });
    default:
      return USAGE;
  }
}

export async function runAdminCli(argv: string[], options: AdminCliOptions = {}): Promise<number> {
  const out = options.out ?? ((line) => void process.stdout.write(line));
  const err = options.err ?? ((line) => void process.stderr.write(line));

  const action = resolveAction(argv, out, err);
  if (typeof action === "string") {
    err(action);
    return EXIT_USAGE;
  }

  return runAsStateOwner(action, err);
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  runAdminCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`[admin] Fatal: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    }
  );
}
