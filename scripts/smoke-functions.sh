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
# The body carries the new inquiry's id as "reference".
check "response body" '{"ok":true,"reference":"<uuid>"}' "$(sed -E 's/"[0-9a-f]{8}-[0-9a-f-]{27}"/"<uuid>"/' /tmp/nhs-smoke-body)"
check "retry with same key" 200 "$(post "$ORIGIN" "$nurse" "Idempotency-Key: smoke-$RUN-key")"
check "disallowed origin" 403 "$(post "https://evil.example" "$nurse")"
bot='{"website":"http://spam.example","email":"bot@example.com"}'
check "honeypot" 200 "$(post "$ORIGIN" "$bot")"
check "missing consent" 400 "$(post "$ORIGIN" "${nurse/\"consent\":true/\"consent\":false}")"
check "error message" '{"error":"Please agree to be contacted so we can follow up."}' "$(cat /tmp/nhs-smoke-body)"
check "employer without organization" 400 "$(post "$ORIGIN" "${nurse/\"type\":\"nurse\"/\"type\":\"employer\"}")"
check "GET not allowed" 405 "$(curl -s -m 120 -o /dev/null -w '%{http_code}' "$BASE/intake")"

# --- apply -------------------------------------------------------------------
# Two synthetic jobs for the dev organization, written with the local service
# role: one open, one closed.
eval "$(npx supabase status -o env 2>/dev/null | grep -E '^(API_URL|SERVICE_ROLE_KEY)=')"
[[ "$API_URL" =~ ^http://(127\.0\.0\.1|localhost): ]] || { echo "Refusing to seed jobs on $API_URL"; exit 1; }
rest() { # method path body
  curl -s -m 120 -X "$1" "$API_URL/rest/v1/$2" -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
    -H 'Content-Type: application/json' -H 'Prefer: return=representation' -d "$3"
}
ORG_ID="$(curl -s -m 120 "$API_URL/rest/v1/organizations?slug=eq.nest-health-staff-dev&select=id" -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" | sed -E 's/.*"id":"([^"]+)".*/\1/')"
make_job() { # status
  local id
  id="$(rest POST jobs "{\"organization_id\":\"$ORG_ID\",\"status\":\"$1\",\"published_at\":\"$(date -u +%FT%TZ)\",\"title\":\"Smoke test job $RUN\",\"specialty\":\"Telemetry\",\"employment_type\":\"travel\",\"city\":\"Austin\",\"state\":\"TX\"}" | sed -E 's/.*"id":"([^"]+)".*/\1/')"
  rest POST job_internal_details "{\"job_id\":\"$id\",\"organization_id\":\"$ORG_ID\",\"facility_name\":\"Smoke Test Facility (synthetic)\"}" > /dev/null
  echo "$id"
}
OPEN_JOB="$(make_job open)"
CLOSED_JOB="$(make_job closed)"

apply() { # origin body
  curl -s -m 120 -o /tmp/nhs-smoke-body -w '%{http_code}' -X POST "$BASE/apply" \
    -H "Origin: $1" -H 'Content-Type: application/json' -d "$2"
}
applicant="{\"job_id\":\"$OPEN_JOB\",\"name\":\"Smoke Applicant\",\"email\":\"apply-$RUN@example.com\",\"phone\":\"\",\"website\":\"\",\"consent\":true}"

check "apply preflight" 204 "$(curl -s -m 120 -o /dev/null -w '%{http_code}' -X OPTIONS "$BASE/apply" -H "Origin: $ORIGIN")"
check "apply to open job" 201 "$(apply "$ORIGIN" "$applicant")"
check "apply response body" '{"ok":true}' "$(cat /tmp/nhs-smoke-body)"
check "apply again, different case" 200 "$(apply "$ORIGIN" "${applicant/apply-$RUN@/APPLY-$RUN@}")"
check "one application saved" "1" "$(curl -s -m 120 "$API_URL/rest/v1/job_applications?job_id=eq.$OPEN_JOB&select=id" -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H 'Prefer: count=exact' -o /dev/null -D - | tr -d '\r' | sed -n 's/^content-range: .*\///Ip')"
check "apply to closed job" 409 "$(apply "$ORIGIN" "${applicant//$OPEN_JOB/$CLOSED_JOB}")"
check "closed job message" '{"error":"This job is no longer taking applications."}' "$(cat /tmp/nhs-smoke-body)"
check "apply to unknown job" 404 "$(apply "$ORIGIN" "${applicant//$OPEN_JOB/00000000-0000-4000-8000-000000000000}")"
check "apply with malformed job id" 400 "$(apply "$ORIGIN" "${applicant//$OPEN_JOB/42}")"
check "apply without consent" 400 "$(apply "$ORIGIN" "${applicant/\"consent\":true/\"consent\":false}")"
check "apply consent message" '{"error":"Please agree to be contacted about this job."}' "$(cat /tmp/nhs-smoke-body)"
check "apply honeypot" 200 "$(apply "$ORIGIN" "${applicant/\"website\":\"\"/\"website\":\"http://spam.example\"}")"
check "apply from disallowed origin" 403 "$(apply "https://evil.example" "$applicant")"
check "apply with form encoding" 415 "$(curl -s -m 120 -o /dev/null -w '%{http_code}' -X POST "$BASE/apply" -H "Origin: $ORIGIN" -d 'name=x')"
check "apply GET not allowed" 405 "$(curl -s -m 120 -o /dev/null -w '%{http_code}' "$BASE/apply")"

check "outbox without secret" 401 "$(curl -s -m 120 -o /dev/null -w '%{http_code}' -X POST "$BASE/process-outbox")"
check "outbox with secret" 200 "$(curl -s -m 120 -o /tmp/nhs-smoke-body -w '%{http_code}' -X POST "$BASE/process-outbox" -H "x-outbox-secret: $SECRET")"
echo "outbox summary: $(cat /tmp/nhs-smoke-body)"

rm -f /tmp/nhs-smoke-body
exit $fail
