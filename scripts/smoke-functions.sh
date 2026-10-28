#!/usr/bin/env bash
# HTTP smoke test for the Edge Functions on the LOCAL stack.
# Requires `npm run functions:serve` with supabase/functions/.env.local.
set -euo pipefail

BASE="${FUNCTIONS_URL:-http://127.0.0.1:55321/functions/v1}"
ORIGIN="${ORIGIN:-http://127.0.0.1:3000}"
SECRET="$(grep '^OUTBOX_PROCESSOR_SECRET=' supabase/functions/.env.local | cut -d= -f2)"
RUN="$(date +%s)"
fail=0

check() { # name expected actual
  if [[ "$2" == "$3" ]]; then echo "PASS $1 ($3)"; else echo "FAIL $1: expected $2, got $3"; fail=1; fi
}

post() { # origin body [extra header]
  curl -s -m 120 -o /tmp/nhs-smoke-body -w '%{http_code}' -X POST "$BASE/intake" \
    -H "Origin: $1" -H 'Content-Type: application/json' ${3:+-H "$3"} -d "$2"
}

nurse="{\"name\":\"Smoke Test\",\"email\":\"smoke-$RUN@example.com\",\"phone\":\"\",\"specialty\":\"Telemetry\",\"location\":\"Austin, TX\",\"timeline\":\"Just exploring\",\"website\":\"\",\"type\":\"nurse\",\"consent\":true}"

check "preflight from allowed origin" 204 "$(curl -s -m 120 -o /dev/null -w '%{http_code}' -X OPTIONS "$BASE/intake" -H "Origin: $ORIGIN")"
check "nurse submission" 201 "$(post "$ORIGIN" "$nurse" "Idempotency-Key: smoke-$RUN-key")"
check "response body" '{"ok":true}' "$(cat /tmp/nhs-smoke-body)"
check "retry with same key" 200 "$(post "$ORIGIN" "$nurse" "Idempotency-Key: smoke-$RUN-key")"
check "disallowed origin" 403 "$(post "https://evil.example" "$nurse")"
bot='{"website":"http://spam.example","email":"bot@example.com"}'
check "honeypot" 200 "$(post "$ORIGIN" "$bot")"
check "missing consent" 400 "$(post "$ORIGIN" "${nurse/\"consent\":true/\"consent\":false}")"
check "error message" '{"error":"Please agree to be contacted so we can follow up."}' "$(cat /tmp/nhs-smoke-body)"
check "employer without organization" 400 "$(post "$ORIGIN" "${nurse/\"type\":\"nurse\"/\"type\":\"employer\"}")"
check "GET not allowed" 405 "$(curl -s -m 120 -o /dev/null -w '%{http_code}' "$BASE/intake")"

check "outbox without secret" 401 "$(curl -s -m 120 -o /dev/null -w '%{http_code}' -X POST "$BASE/process-outbox")"
check "outbox with secret" 200 "$(curl -s -m 120 -o /tmp/nhs-smoke-body -w '%{http_code}' -X POST "$BASE/process-outbox" -H "x-outbox-secret: $SECRET")"
echo "outbox summary: $(cat /tmp/nhs-smoke-body)"

rm -f /tmp/nhs-smoke-body
exit $fail
