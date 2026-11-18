#!/usr/bin/env bash
# Production smoke test for the UUGet billing Worker.
# Creates a device, reads entitlement, creates a live Creem checkout (no charge),
# and checks that unsigned/forged webhooks and unknown license keys are rejected.
#
# Usage:
#   BASE=https://uuget.uu0uu.com ./scripts/smoke-production.sh
#   BASE=https://uuget.uu0uu.com RESOLVE_IP=104.21.36.232 ./scripts/smoke-production.sh
set -euo pipefail

BASE="${BASE:-https://uuget.uu0uu.com}"
CURL=(curl -sS -m 30)
if [[ -n "${RESOLVE_IP:-}" ]]; then
  CURL+=(--resolve "uuget.uu0uu.com:443:${RESOLVE_IP}")
fi

DEVICE_ID="dev_smoke-$(date +%s)-$(openssl rand -hex 4)"
DEVICE_TOKEN="smoke_$(openssl rand -hex 24)"
AUTH="Authorization: Bearer ${DEVICE_TOKEN}"
JSON="Content-Type: application/json"

echo "== health =="
"${CURL[@]}" -w '\nstatus=%{http_code}\n' "$BASE/health"

echo "== register =="
"${CURL[@]}" -X POST -H "$JSON" \
  --data "{\"deviceId\":\"$DEVICE_ID\",\"deviceToken\":\"$DEVICE_TOKEN\"}" \
  -w '\nstatus=%{http_code}\n' "$BASE/v1/devices/register" | sed "s/$DEVICE_TOKEN/<redacted>/g"

echo "== entitlement =="
"${CURL[@]}" -H "$AUTH" -w '\nstatus=%{http_code}\n' "$BASE/v1/entitlement"

echo "== checkout credits_10 (live session, no charge) =="
"${CURL[@]}" -X POST -H "$JSON" -H "$AUTH" \
  --data '{"productKey":"credits_10"}' \
  -w '\nstatus=%{http_code}\n' "$BASE/v1/checkout"

echo "== webhook without signature =="
"${CURL[@]}" -X POST -H "$JSON" --data '{"id":"evt_smoke","eventType":"checkout.completed"}' \
  -w '\nstatus=%{http_code}\n' "$BASE/webhooks/creem"

echo "== webhook with forged signature =="
"${CURL[@]}" -X POST -H "$JSON" -H "creem-signature: $(openssl rand -hex 32)" \
  --data '{"id":"evt_smoke","eventType":"checkout.completed"}' \
  -w '\nstatus=%{http_code}\n' "$BASE/webhooks/creem"

echo "== license activate with unknown key =="
"${CURL[@]}" -X POST -H "$JSON" -H "$AUTH" \
  --data '{"licenseKey":"SMOKE-0000-0000-0000"}' \
  -w '\nstatus=%{http_code}\n' "$BASE/v1/license/activate"

echo "smoke device: $DEVICE_ID"
