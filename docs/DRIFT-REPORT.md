# Drift Report — ARCHITECTURE.md / PUBLISHER-DEPLOYMENT.md vs. validator behaviour

Generated: 2026-08-06. Commit audited: `a1bb4429` (v0.8.3).

This report lists divergences between the two static documentation files
(`docs/ARCHITECTURE.md` and `docs/PUBLISHER-DEPLOYMENT.md`) and the behaviour
actually implemented in `src/`. Claims of absence were verified with keyword
searches before being recorded.

---

## D1 — Tool count (ARCHITECTURE.md)

**Source:** `docs/ARCHITECTURE.md`, subgraph declaration line 25.

**Claim:** `subgraph Core["server.ts — 3 MCP tools"]` with nodes
`T1[well_known_capabilities]`, `T2[discover_products]`, `T3[get_forecast]`.

**Reality:** `src/server.ts` registers **five** tools via five `server.tool()`
calls (lines 183, 197, 258, 321, 414): `well_known_capabilities`,
`discover_products`, `get_forecast`, `create_intent`, `revoke_intent`.
`create_intent` and `revoke_intent` were added in v0.5.0; the diagram was not
updated.

**Impact:** Any reader using ARCHITECTURE.md to understand the node's write
surface will miss `create_intent` and `revoke_intent` — the only tools that
modify state.

---

## D2 — "External anchoring" (ARCHITECTURE.md)

**Source:** `docs/ARCHITECTURE.md`, mermaid node line 56 and prose section
"Audit chain".

**Claim:**
- Mermaid node: `ANC[anchor.ts — external anchoring]`
- Prose: "Entries are periodically anchored externally (a batched head-hash
  write) so that tampering with the local ledger file alone isn't enough to
  rewrite history undetected."

**Reality:** `src/audit/anchor.ts:68-78` writes the head hash to a **local
file** using `writeFileSync` (synchronous, rewritable). The code comment at
line 72 reads: `"Production: use cloud-immutable write instead (never
overwrite)"`. No external write, no Object Lock, no cloud storage integration
exists in the current codebase. The anchor file can be overwritten or deleted
without breaking chain verification (since `verifyAfterRestore()` is also not
called on startup — see D5 below).

**Impact:** The "tamper with local file alone isn't enough" guarantee stated in
the prose is not upheld by the current implementation: a local file is the
only anchor, and it is rewritable.

---

## D3 — "Config-file entitlements planned" (ARCHITECTURE.md)

**Source:** `docs/ARCHITECTURE.md`, section "What doesn't exist yet".

**Claim:** "**Config-file-based entitlements.** Buyer entitlements are
currently code fixtures; moving them to a JSON file (matching how catalog and
deployment config already work) is planned."

**Reality:** `src/policy/entitlements.ts:169-170` exports
`loadEntitlementsFromFile()`, which reads from `config/entitlements.json` (or
the path resolved by `resolveConfigPath("entitlements.json")`). This function
is called from `src/server.ts:7,52` at startup. The feature is **already
implemented**. The "What doesn't exist yet" entry is stale.

**Impact:** Documentation describes a missing feature that is present; a reader
following the doc to understand extension points will not find the expected
code-fixture pattern.

---

## D4 — `node_id_prefix` config key (PUBLISHER-DEPLOYMENT.md)

**Source:** `docs/PUBLISHER-DEPLOYMENT.md`, Step 2 "Configure", subsection
`deployment.json`.

**Claim:** The example `deployment.json` includes:
```json
{
  "node_id_prefix": "your-network-name",
  ...
}
```
with the implication that this field controls the node identifier exposed in
the well-known document.

**Reality:** No code in `src/` reads a `node_id_prefix` field from
`deployment.json`. The node identifier is a **hardcoded constant** in
`src/discovery/well-known.ts:93`:
```typescript
private readonly nodeId = "seller-mcp-node-mvp"
```
The example config in `config/examples/pilot-publisher/deployment.json`
contains no `node_id_prefix` key. Setting this field in a real deployment has
no effect.

**Impact:** Publishers following the deployment guide will assume they can
customize their node identity via config; they cannot. All deployed nodes share
the same `node_id` value, making per-publisher discovery indistinguishable at
the identity level.

---

## D5 — Chain integrity not verified on startup (README / ARCHITECTURE.md)

**Source:** `docs/ARCHITECTURE.md` prose and README security model.

**Claim:** The architecture describes an audit chain whose integrity can be
verified ("tampering with the local ledger file alone isn't enough to rewrite
history undetected").

**Reality:** `src/audit/anchor.ts:93-121` implements `verifyAfterRestore()`,
which checks the ledger chain against the anchored head hash. This function is
**never called** in `src/server.ts:main()` before the node begins serving
requests. A tampered ledger is not detected at startup; it would only be
detected if `verifyAfterRestore()` is called explicitly by an operator tool.

**Impact:** The detection guarantee implied by the architecture is not active
in the default operating mode. An adversary who modifies the local ledger file
and the local anchor file before a restart will not be detected automatically.

---

## D6 — DSR toolkit import path assumes source; CLI absent from npm (PUBLISHER-DEPLOYMENT.md)

**Source:** `docs/PUBLISHER-DEPLOYMENT.md`, section "GDPR / data-subject
requests".

**Claim:**
```typescript
import { DsrToolkit } from "./src/dsr/toolkit.js";
// export, restrict, erase a buyer's pseudonymized audit records
```
The section implies the DSR toolkit is accessible to publishers who deploy
via npm.

**Reality:** `package.json` `files` field lists `['dist', 'config/examples',
'README.md', 'LICENSE', 'PRIVACY.md', 'CHANGELOG.md']`. The scripts
`scripts/dsr.ts`, `scripts/issue-buyer-token.ts`, and `scripts/revoke-token.ts`
are **not included** in the npm distribution. Publishers who install via
`npx gam-seller-mcp-node` or Docker cannot invoke the DSR CLI without cloning
the source repository. The `src/dsr/toolkit.ts` module is compiled into
`dist/` and is technically importable from the distributed package, but the
import path shown in the docs (`./src/dsr/toolkit.js`) is incorrect for
installed packages (it should be `./dist/dsr/toolkit.js` or
`gam-seller-mcp-node/dist/dsr/toolkit.js`).

**Impact:** A publisher receiving a GDPR Art. 17 erasure request who followed
the deployment guide (npm/Docker) cannot immediately invoke the DSR toolkit;
they must first clone the repository, which is not documented in the guide.

---

## Summary table

| ID | Doc | Claim | Status |
|----|-----|-------|--------|
| D1 | ARCHITECTURE.md | "3 MCP tools" in Core subgraph | **Stale** — 5 tools since v0.5.0 |
| D2 | ARCHITECTURE.md | "external anchoring" | **Inaccurate** — local rewritable file |
| D3 | ARCHITECTURE.md | "Config-file entitlements planned" | **Stale** — already implemented |
| D4 | PUBLISHER-DEPLOYMENT.md | `node_id_prefix` config key | **Unimplemented** — field has no effect |
| D5 | ARCHITECTURE.md + README | Chain verified on startup | **Unimplemented** — `verifyAfterRestore()` not called in `main()` |
| D6 | PUBLISHER-DEPLOYMENT.md | DSR toolkit accessible via npm | **Partial** — CLI absent from distribution; import path incorrect |
