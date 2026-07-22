# Contributing to GAM Seller MCP Node

Thank you for your interest in contributing. This project is an early-stage but production-minded
MCP server — contributions that improve correctness, security, documentation, and real-world
deployability are most welcome.

## What we're looking for

- **Bug fixes** — especially anything that weakens the Default-Deny guarantee or produces incorrect
  audit entries
- **Real GAM adapter** — the highest-impact open item (see [the tracking issue](https://github.com/juan-sibbo/gam-seller-mcp-node/issues))
- **Buyer agent SDKs** — Python and TypeScript client helpers for the MCP buyer flow
- **Documentation** — publisher deployment guides, buyer agent integration examples
- **Tests** — additional edge cases for the policy engine, pricing expiry, and audit chain

## Development setup

```bash
git clone https://github.com/juan-sibbo/gam-seller-mcp-node.git
cd gam-seller-mcp-node
npm install
npm run build       # compile TypeScript
npm test            # run full test suite (vitest)
npx tsc --noEmit    # type-check without emitting
```

The test suite runs entirely in-memory — no external services, no GAM connection, no Docker
required for the core tests.

## Project layout

```
src/
  server.ts          # MCP tool definitions + request pipeline (start here)
  policy/            # Default-Deny engine — most security-sensitive code
  identity/          # RS256 keys, token issuance/validation, revocation
  audit/             # Hash-chained ledger, pseudonymization, anchoring
  pricing/           # Firm list price store (fail-closed on expiry)
  forecast/          # Bucket engine + GAM adapter seam
  catalog/           # Product family store
  dsr/               # GDPR data-subject-rights toolkit
  config/            # Deployment config loader
  rate-limiter/      # Per-buyer rate limiter
  errors/            # Error envelope (opaque to buyers)
config/              # Runtime config (JSON, no secrets)
tests/               # Vitest test suite
sandbox/             # External probes (Python buyer-agent probe)
docs/                # Architecture and design documentation
```

## Coding conventions

- **TypeScript strict mode** — no `any` without a comment explaining why
- **Immutable data** — avoid mutation; return new objects
- **Fail closed** — when in doubt about the safety of an operation, reject it
- **No silent errors** — every catch block must log or propagate
- **Tests required** — new behaviour must have a test before the PR is merged

The security-sensitive modules (`policy/`, `identity/`, `audit/`) have a higher bar: changes
there need explicit reasoning about what the change does to the Default-Deny guarantee.

## Running specific tests

```bash
npx vitest run tests/policy.test.ts         # policy engine
npx vitest run tests/pricing.test.ts        # pricing expiry
npx vitest run tests/buyer-agent-session.test.ts  # end-to-end session
python3 sandbox/buyer-agent-probe.py        # external HTTP probe (needs a running server)
```

## Adding a new publisher configuration

No code changes needed for a new publisher. Copy
`config/examples/pilot-publisher/` to a new directory, edit the four JSON files, and
bind-mount them over `config/` in Docker. See
[`docs/PUBLISHER-DEPLOYMENT.md`](docs/PUBLISHER-DEPLOYMENT.md) for a step-by-step guide.

## Pull request checklist

- [ ] `npm test` passes locally (or CI is green)
- [ ] `npx tsc --noEmit` passes (no type errors)
- [ ] New behaviour has a test
- [ ] Security-sensitive changes include a note on the Default-Deny impact
- [ ] No hardcoded secrets, buyer IDs, or floor prices in committed code

## Opening issues

- **Bug reports** — use the bug report template; include the request_id from the error response
  if you have one
- **Feature requests** — use the feature request template; describe the use case, not just the
  solution
- **Publisher integrations** — use the publisher integration template if you're deploying for a
  specific ad server or broadcaster

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
