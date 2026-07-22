# Security Policy

## Supported versions

This project is pre-1.0. The `main` branch is the supported version.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Email: sibboconsulting@gmail.com

Include:
- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept (even a partial one is helpful)
- The version/commit you tested against

You will receive an acknowledgement within 48 hours and a status update within 7 days.

## Scope

Security issues in these areas are highest priority:

- **Default-Deny bypass** — any path that lets a buyer reach a denied surface without an explicit
  entitlement
- **Audit chain integrity** — anything that allows tampering with the hash-chained ledger without
  detection
- **Identity / token forgery** — weaknesses in the RS256 issuance or validation path
- **Data leakage** — buyer-visible responses that contain data from the denylist (exact pricing,
  deal IDs, raw avails, audience attributes)
- **Replay attack** — bypassing SEC-GATE-3 replay detection

Issues in the synthetic data layer (catalog, forecast engine) or in documentation are lower
priority and can be reported as normal GitHub issues.

## What we will not fix

- Vulnerabilities that require direct file-system or process access on the server — this project
  assumes a trusted host environment. Operator-level compromise is out of scope.
- Issues in dependencies that have upstream fixes available — open a PR updating the dependency.
