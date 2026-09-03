#!/usr/bin/env bash
#
# One-command pilot launcher for the GAM Seller MCP Node.
#
# Brings the node up on a config directory with production-grade guards, mints a buyer token per
# entitled buyer, prints everything a pilot needs (tokens + how to drive a buyer agent), then runs
# the node in the FOREGROUND (Ctrl-C to stop). Everything here is configuration — it needs no
# credentials and no live GAM. The only human inputs are your real config files and, later, a GAM
# service account (see docs/PILOT-QUICKSTART.md and docs/PUBLISHER-DEPLOYMENT.md).
#
# Usage:
#   scripts/pilot.sh [buyer_id ...]
#
# Env:
#   MCP_CONFIG_DIR   real operator config dir (deployment/catalog/entitlements/pricing[/forecast].json).
#                    Unset → the bundled config/examples/pilot-publisher demo (announced as demo).
#   MCP_HTTP_PORT    default 3900
#   MCP_ANCHOR_SINK  default "file" (set "tsa" to anchor to an RFC 3161 timestamp authority)
#   PILOT_STATE_DIR  default ".pilot" (holds data/, keys/, node.log — gitignore it)
#
# If no buyer_id args are given, tokens are minted for every buyer named in the config's
# entitlements.json (falling back to pilot-buyer-001 for the bundled demo).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${MCP_HTTP_PORT:-3900}"
STATE_DIR="${PILOT_STATE_DIR:-.pilot}"
DATA_DIR="$STATE_DIR/data"
KEYS_DIR="$STATE_DIR/keys"
mkdir -p "$DATA_DIR" "$KEYS_DIR"

# --- Hardening env (the road-readiness checklist, applied) ---------------------------------------
export MCP_HTTP_PORT="$PORT"
export MCP_DATA_DIR="$DATA_DIR"
export MCP_KEYS_DIR="$KEYS_DIR"
export MCP_REQUIRE_IDEMPOTENCY_KEY=1
export MCP_ANCHOR_SINK="${MCP_ANCHOR_SINK:-file}"
export MCP_INTENT_HANDOFF="${MCP_INTENT_HANDOFF:-file}"
export MCP_INTENT_HANDOFF_FILE="$DATA_DIR/intent-handoff.jsonl"

CONFIG_SRC="config/examples/pilot-publisher"
if [ -n "${MCP_CONFIG_DIR:-}" ]; then
  export MCP_REQUIRE_OPERATOR_CONFIG=1   # refuse to boot on the demo example — this is a real pilot
  CONFIG_SRC="$MCP_CONFIG_DIR"
  echo "› config: real operator config at $MCP_CONFIG_DIR (demo fallback disabled)"
else
  echo "› config: bundled demo example (set MCP_CONFIG_DIR for a real pilot)"
fi

# --- Build ---------------------------------------------------------------------------------------
echo "› building…"
npm run build >/dev/null

# --- Resolve which buyers to mint tokens for -----------------------------------------------------
BUYERS=("$@")
if [ ${#BUYERS[@]} -eq 0 ]; then
  ENT="$CONFIG_SRC/entitlements.json"
  if [ -f "$ENT" ]; then
    while IFS= read -r b; do [ -n "$b" ] && BUYERS+=("$b"); done < <(
      node -e 'const fs=require("fs");const e=JSON.parse(fs.readFileSync(process.argv[1],"utf-8"));console.log([...new Set((e.entitlements||[]).map(x=>x.buyer_id))].join("\n"))' "$ENT"
    )
  fi
fi
[ ${#BUYERS[@]} -eq 0 ] && BUYERS=("pilot-buyer-001")

# --- Mint tokens BEFORE the server starts (mint writes the ledger/anchor the server then verifies) -
echo "› minting buyer tokens (${#BUYERS[@]}): ${BUYERS[*]}"
TOKENS_FILE="$STATE_DIR/tokens.env"
: > "$TOKENS_FILE"
for b in "${BUYERS[@]}"; do
  TOK="$(npx tsx scripts/issue-buyer-token.ts "$b" 2>/dev/null)"
  printf '%s=%s\n' "$b" "$TOK" >> "$TOKENS_FILE"
done

# --- Print the pilot handoff ---------------------------------------------------------------------
BASE="http://127.0.0.1:$PORT"
cat <<BANNER

────────────────────────────────────────────────────────────────────────
  PILOT READY — node at $BASE
────────────────────────────────────────────────────────────────────────
  Buyer tokens (also saved to $TOKENS_FILE):
BANNER
while IFS='=' read -r b tok; do
  printf '    · %-24s %s…\n' "$b" "${tok:0:24}"
done < "$TOKENS_FILE"
FIRST_TOKEN="$(head -n1 "$TOKENS_FILE" | cut -d= -f2-)"
cat <<BANNER

  Drive a buyer agent (full loop: discover → forecast → commit → revoke):
    npx tsx examples/buyer-client-ts/agent.ts "\$TOKEN" $BASE
  where \$TOKEN is one of the tokens above, e.g.:
    npx tsx examples/buyer-client-ts/agent.ts "$FIRST_TOKEN" $BASE

  Committed intents are delivered to: $MCP_INTENT_HANDOFF_FILE
  Health:  curl $BASE/health
  Stop:    Ctrl-C
────────────────────────────────────────────────────────────────────────

BANNER

# --- Run the node in the foreground (Ctrl-C stops it) --------------------------------------------
exec node dist/server.js --http
