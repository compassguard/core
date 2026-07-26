#!/usr/bin/env bash
#
# Live smoke test for GET /v1/metrics.
#
# Exercises the real endpoint end-to-end: health -> signup (mint token) ->
# POST /v1/verify allow -> POST /v1/verify deny -> GET /v1/metrics. Prints
# each step and a PASS/FAIL summary.
#
# Usage:
#   scripts/metrics-live.sh                                  # prod, self-serve a fresh key
#   BASE_URL=http://localhost:3001 scripts/metrics-live.sh   # local backend (prefix auto-detected)
#   COMPASS_HOSTED_API_KEY=compass_… scripts/metrics-live.sh # reuse a key (skip signup)
#   EMAIL=me@example.com scripts/metrics-live.sh             # pick the signup email
#
# BASE_URL may point at either the app root (prod / bun server) or a Next.js dev
# server — the /api/hosted prefix is auto-detected against /health.
#
# Requires: curl, jq.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3001}"
BASE_URL="${BASE_URL%/}"                       # strip any trailing slash
EMAIL="${EMAIL:-metrics-smoke+$(date +%s)@compassguard.xyz}"

PASS="\033[32m✓\033[0m"
FAIL="\033[31m✗\033[0m"
INFO="\033[36m→\033[0m"
DIM="\033[2m"; RST="\033[0m"

pass_count=0
fail_count=0
ST=""; BODY=""   # set by req()

command -v jq >/dev/null || { echo "jq is required (brew install jq)"; exit 1; }

# req METHOD PATH [BODY] [auth|noauth]  → sets globals ST (http code) and BODY (response body).
# Status is appended on its OWN line so a large/multi-line HTML body can never corrupt it.
req() {
  local method="$1" path="$2" body="${3:-}" auth="${4:-auth}"
  local -a args=(-sS -X "$method" "${BASE_URL}${path}")
  [ "$method" != "GET" ] && args+=(-H "Content-Type: application/json" -d "$body")
  [ "$auth" = "auth" ] && [ -n "${TOKEN:-}" ] && args+=(-H "Authorization: Bearer ${TOKEN}")
  local raw
  raw="$(curl "${args[@]}" -w $'\n%{http_code}' 2>/dev/null || true)"
  ST="${raw##*$'\n'}"       # last line = status code
  BODY="${raw%$'\n'*}"      # everything before it = body
}

# check <label> <expected> <actual> [<detail>]
check() {
  local label="$1" expected="$2" actual="$3" detail="${4:-}"
  if [ "$actual" = "$expected" ]; then
    echo -e "  ${PASS} ${label} ${DIM}→ ${actual}${RST}"
    pass_count=$((pass_count + 1))
  else
    echo -e "  ${FAIL} ${label} ${DIM}(expected ${expected}, got '${actual:-<empty>}')${RST} ${detail}"
    fail_count=$((fail_count + 1))
  fi
}

# check_true <label> <condition-string 'true'|'false'> [<detail>]
check_true() {
  local label="$1" condition="$2" detail="${3:-}"
  if [ "$condition" = "true" ]; then
    echo -e "  ${PASS} ${label}"
    pass_count=$((pass_count + 1))
  else
    echo -e "  ${FAIL} ${label} ${DIM}${detail}${RST}"
    fail_count=$((fail_count + 1))
  fi
}

# ── Resolve base URL: try as-is, then with the /api/hosted prefix (Next dev) ──
resolve_base() {
  local candidate
  for candidate in "$BASE_URL" "${BASE_URL}/api/hosted"; do
    if [ "$(curl -sS "${candidate}/health" 2>/dev/null | jq -r '.ok // empty' 2>/dev/null)" = "true" ]; then
      BASE_URL="$candidate"
      return 0
    fi
  done
  return 1
}

echo -e "${INFO} Resolving base URL from: ${BASE_URL}"
if ! resolve_base; then
  echo -e "  ${FAIL} No healthy hosted API at ${BASE_URL} (or ${BASE_URL}/api/hosted)."
  echo -e "     ${DIM}Is the server up? Local: 'COMPASS_HOSTED_API_KEY=dev-local-key npm run hosted:dev'${RST}"
  echo -e "     ${DIM}then BASE_URL=http://localhost:3001 scripts/metrics-live.sh${RST}"
  exit 1
fi
echo -e "  ${PASS} healthy API at ${BASE_URL}"

# ── Token: reuse COMPASS_HOSTED_API_KEY or self-serve via /signup ────────────
if [ -n "${COMPASS_HOSTED_API_KEY:-}" ]; then
  TOKEN="$COMPASS_HOSTED_API_KEY"
  echo -e "\n${INFO} Using COMPASS_HOSTED_API_KEY from env (skipping signup)"
else
  echo -e "\n${INFO} POST /signup (email: ${EMAIL})"
  req POST /signup "{\"email\":\"${EMAIL}\"}" noauth
  TOKEN="$(echo "$BODY" | jq -r '.apiKey // empty' 2>/dev/null || true)"
  if [ -z "$TOKEN" ]; then
    echo -e "  ${FAIL} signup unavailable (http ${ST}). Re-run with a shared key:"
    echo -e "     ${DIM}COMPASS_HOSTED_API_KEY=<key> BASE_URL=${BASE_URL} scripts/metrics-live.sh${RST}"
    exit 1
  fi
  echo -e "  ${PASS} minted token ${DIM}${TOKEN:0:12}…${RST}"
fi

# ── /v1/verify allow + deny (feed onboarding + funds-secured) ────────────────
RCPT="9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"

echo -e "\n${INFO} POST /v1/verify — allow (amountUsd 5, recipientKnown true)"
req POST /v1/verify "{\"toolName\":\"transfer_sol\",\"intent\":{\"kind\":\"transfer\"},\"arguments\":{\"recipient\":\"${RCPT}\",\"amountUsd\":5,\"recipientKnown\":true}}"
check "known recipient, small amt -> allow" "allow" "$(echo "$BODY" | jq -r '.decision // .error.code // empty')"

echo -e "\n${INFO} POST /v1/verify — deny (mystery_drain, amountUsd 7)"
req POST /v1/verify "{\"toolName\":\"mystery_drain\",\"intent\":{\"kind\":\"transfer\"},\"arguments\":{\"amountUsd\":7}}"
check "unrecognized tool -> deny" "deny" "$(echo "$BODY" | jq -r '.decision // .error.code // empty')"

# ── GET /v1/metrics ───────────────────────────────────────────────────────────
echo -e "\n${INFO} GET /v1/metrics"
req GET /v1/metrics "" auth
check "http 200" "200" "$ST"

USERS="$(echo "$BODY" | jq -r '.onboarding.users // 0')"
check_true "onboarding.users >= 1" "$([ "$USERS" -ge 1 ] && echo true || echo false)" "(got ${USERS})"

PER_USER_ENTRY="$(echo "$BODY" | jq -r --arg email "$EMAIL" '.onboarding.perUser[] | select(.email == $email)')"
if [ -n "$PER_USER_ENTRY" ]; then
  echo -e "  ${PASS} signup email appears in perUser"
  pass_count=$((pass_count + 1))
  SECONDS_TO_FIRST_VERIFY="$(echo "$PER_USER_ENTRY" | jq -r '.secondsToFirstVerify // "null"')"
  if [ "$SECONDS_TO_FIRST_VERIFY" != "null" ]; then
    check_true "secondsToFirstVerify >= 0" \
      "$(awk -v n="$SECONDS_TO_FIRST_VERIFY" 'BEGIN { print (n >= 0) ? "true" : "false" }')" \
      "(got ${SECONDS_TO_FIRST_VERIFY})"
  else
    echo -e "  ${FAIL} secondsToFirstVerify is null for ${EMAIL}"
    fail_count=$((fail_count + 1))
  fi
else
  echo -e "  ${FAIL} signup email ${EMAIL} not found in onboarding.perUser ${DIM}(skipped signup with a reused key?)${RST}"
  fail_count=$((fail_count + 1))
fi

TOTAL_USD="$(echo "$BODY" | jq -r '.fundsSecured.totals.totalUsd // 0')"
check_true "fundsSecured.totals.totalUsd >= 12" \
  "$(awk -v n="$TOTAL_USD" 'BEGIN { print (n >= 12) ? "true" : "false" }')" "(got ${TOTAL_USD})"

ALLOW_USD="$(echo "$BODY" | jq -r '.fundsSecured.totals.allowUsd // 0')"
check_true "fundsSecured.totals.allowUsd >= 5" \
  "$(awk -v n="$ALLOW_USD" 'BEGIN { print (n >= 5) ? "true" : "false" }')" "(got ${ALLOW_USD})"

DENY_USD="$(echo "$BODY" | jq -r '.fundsSecured.totals.denyUsd // 0')"
check_true "fundsSecured.totals.denyUsd >= 7" \
  "$(awk -v n="$DENY_USD" 'BEGIN { print (n >= 7) ? "true" : "false" }')" "(got ${DENY_USD})"

BY_DAY_LEN="$(echo "$BODY" | jq -r '.fundsSecured.byDay | length')"
check_true "fundsSecured.byDay non-empty" "$([ "$BY_DAY_LEN" -gt 0 ] && echo true || echo false)" "(got ${BY_DAY_LEN} days)"

# ── Summary ──────────────────────────────────────────────────────────────────
echo -e "\n${INFO} ${pass_count} passed, ${fail_count} failed"
[ "$fail_count" -eq 0 ] || exit 1
