import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AuditLedger } from "../src/audit/ledger.js";
import { HeadHashAnchor, verifyAfterRestore } from "../src/audit/anchor.js";
import { PseudonymService } from "../src/audit/pseudonym.js";
import { Denylist } from "../src/identity/denylist.js";
import { recordTokenIssuance } from "../src/identity/token-audit.js";
import { EntitlementStore } from "../src/policy/entitlements.js";
import { IntentStore } from "../src/intent/store.js";
import { EventClass } from "../src/audit/event.js";

// Characterization of the multi-writer hazard behind the owner lease (src/durability/owner-lease.ts).
//
// Every file-backed store loads its file ONCE (constructor) and afterwards rewrites it from
// memory. Two processes holding the same store — the running server and an operator CLI — each
// have their own in-memory copy, so a CLI write is either IGNORED by the server (it never
// re-reads) or OVERWRITTEN by the server's next save. Two instances on the same files below model
// exactly that. These tests pin the store semantics that make a single state owner mandatory;
// they are not a bug in any one store, and the fix is to never let two owners coexist.

let dir: string;
const p = (name: string) => join(dir, name);
const SERVER_BUYER = "buyer-a";
const ENTITLEMENTS = {
  entitlements: [{ buyer_id: SERVER_BUYER, surfaces: ["discovery"], scopes: ["gam.readonly"], phase: "phase-1-readonly" }],
} as never;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "state-owner-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("multi-writer hazard (why state needs a single owner)", () => {
  it("token issuance by a CLI is overwritten by the server and bricks the next boot", () => {
    const server = new AuditLedger(p("ledger.json"), new PseudonymService(p("pk.json")));
    server.append(EventClass.BUYER_AUTHENTICATION, { outcome: "ok" }, { buyer_id: SERVER_BUYER });

    // CLI process: same files, own memory — exactly scripts/issue-buyer-token.ts.
    const cli = new AuditLedger(p("ledger.json"), new PseudonymService(p("pk.json")));
    recordTokenIssuance(cli, { buyer_id: "buyer-b", jti: "jti-1", aud: "seller-mcp-node", exp: 1893456000 });
    new HeadHashAnchor(p("anchor.json")).anchor(cli.headHash(), cli.headSeq());

    // The server keeps serving and saves its own view of the chain.
    server.append(EventClass.BUYER_AUTHENTICATION, { outcome: "ok" }, { buyer_id: SERVER_BUYER });

    const reboot = new AuditLedger(p("ledger.json"), new PseudonymService(p("pk.json")));
    const lost = !reboot.allEntries().some((e) => e.event_class === EventClass.TOKEN_ISSUANCE);
    const verify = verifyAfterRestore(reboot.headHash(), () => reboot.replayVerify(), new HeadHashAnchor(p("anchor.json")), (seq) => reboot.hashAt(seq));
    expect(lost).toBe(true);
    expect(verify.valid).toBe(false);
    expect(verify.error).toBe("anchored_prefix_mismatch");
  });

  it("a token revoked by a CLI is still accepted by the running server", () => {
    const server = new Denylist(p("denylist.json"));
    new Denylist(p("denylist.json")).add("jti-compromised", Date.now() + 3_600_000);
    expect(server.has("jti-compromised")).toBe(false);
  });

  it("an Art. 18 restriction by the DSR CLI is not enforced by the running server", () => {
    const server = new EntitlementStore(ENTITLEMENTS, p("dsr.json"));
    expect(new EntitlementStore(ENTITLEMENTS, p("dsr.json")).suspend(SERVER_BUYER)).toBe(true);
    expect(server.has(SERVER_BUYER)).toBe(true);
  });

  it("an Art. 17 crypto-shred by the DSR CLI is undone by the server's next key save", () => {
    const server = new PseudonymService(p("pk.json"));
    server.pseudonymize(SERVER_BUYER); // key created + persisted

    expect(new PseudonymService(p("pk.json")).shred(SERVER_BUYER)).toBe(true);
    server.pseudonymize("another-buyer"); // new key → server saves its whole in-memory keyring

    expect(new PseudonymService(p("pk.json")).hasKey(SERVER_BUYER)).toBe(true);
  });

  it("an Art. 17 intent purge by the DSR CLI is undone by the server's next intent save", () => {
    const server = new IntentStore(undefined, p("intents.json"));
    const input = { family_id: "f", period: "Q4", firm_price: 1, currency: "EUR", price_valid_until: "2099-01-01T00:00:00Z" };
    server.create({ ...input, buyer_id: SERVER_BUYER });

    expect(new IntentStore(undefined, p("intents.json")).purgeBuyer(SERVER_BUYER)).toBe(1);
    server.create({ ...input, buyer_id: "another-buyer" });

    expect(readFileSync(p("intents.json"), "utf-8")).toContain(SERVER_BUYER);
  });
});
