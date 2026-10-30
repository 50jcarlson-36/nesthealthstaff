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

# --- staff-invite --------------------------------------------------------------
# Only ward may call it, and only with a session; the signed-in cases are in
# tests/integration/staff.test.ts.
WARD="${WARD_ORIGIN:-http://127.0.0.1:3003}"
invite() { # origin [authorization]
  curl -s -m 120 -o /tmp/nhs-smoke-body -w '%{http_code}' -X POST "$BASE/staff-invite" \
    -H "Origin: $1" -H 'Content-Type: application/json' ${2:+-H "Authorization: $2"} \
    -d '{"organization_id":"00000000-0000-4000-8000-000000000000","email":"smoke-invite@example.com","role":"recruiter"}'
}
check "invite preflight from ward" 204 "$(curl -s -m 120 -o /dev/null -w '%{http_code}' -X OPTIONS "$BASE/staff-invite" -H "Origin: $WARD")"
check "invite from the public site" 403 "$(invite "$ORIGIN")"
check "invite without a session" 401 "$(invite "$WARD")"
check "invite with a bad token" 401 "$(invite "$WARD" "Bearer not-a-token")"
check "invite GET not allowed" 405 "$(curl -s -m 120 -o /dev/null -w '%{http_code}' "$BASE/staff-invite")"

# --- consent -------------------------------------------------------------------
# Public, from ward's /consent page only. Answering a real request is covered
# in tests/integration/partners.test.ts.
consent() { # origin body
  curl -s -m 120 -o /tmp/nhs-smoke-body -w '%{http_code}' -X POST "$BASE/consent" \
    -H "Origin: $1" -H 'Content-Type: application/json' -d "$2"
}
check "consent preflight from ward" 204 "$(curl -s -m 120 -o /dev/null -w '%{http_code}' -X OPTIONS "$BASE/consent" -H "Origin: $WARD")"
check "consent from another site" 403 "$(consent "https://evil.example" '{"token":"x","action":"view"}')"
check "consent with a malformed token" 404 "$(consent "$WARD" '{"token":"nope","action":"view"}')"
check "consent with an unknown token" 404 "$(consent "$WARD" '{"token":"0000000000000000000000000000000000000000000000000000000000000000","action":"granted"}')"
check "consent GET not allowed" 405 "$(curl -s -m 120 -o /dev/null -w '%{http_code}' "$BASE/consent")"

# --- travel-data ---------------------------------------------------------------
# Staff only, from ward. A real lookup calls the GSA API (rate-limited with
# DEMO_KEY), so it's checked by hand in ward rather than here.
travel() { # origin [auth]
  curl -s -m 120 -o /tmp/nhs-smoke-body -w '%{http_code}' -X POST "$BASE/travel-data" \
    -H "Origin: $1" -H 'Content-Type: application/json' ${2:+-H "Authorization: $2"} -d '{"job_id":"00000000-0000-4000-8000-000000000000"}'
}
check "travel preflight from ward" 204 "$(curl -s -m 120 -o /dev/null -w '%{http_code}' -X OPTIONS "$BASE/travel-data" -H "Origin: $WARD")"
check "travel from the public site" 403 "$(travel "$ORIGIN")"
check "travel without a session" 401 "$(travel "$WARD")"
check "travel with a bad token" 401 "$(travel "$WARD" "Bearer not-a-token")"
check "travel GET not allowed" 405 "$(curl -s -m 120 -o /dev/null -w '%{http_code}' "$BASE/travel-data")"

# --- partner-api ---------------------------------------------------------------
# Server-to-server with a partner API key. Events that change data are covered
# in tests/integration/connector.test.ts; this checks the HTTP layer with a
# synthetic partner and a key written straight to the local database.
PARTNER_ID="$(rest POST partners "{\"organization_id\":\"$ORG_ID\",\"name\":\"Smoke Partner $RUN (synthetic)\",\"status\":\"active\",\"agreement_signed_on\":\"2026-10-01\",\"attribution_days\":90}" | sed -E 's/.*"id":"([^"]+)".*/\1/')"
PARTNER_KEY="nhs_pk_$(openssl rand -hex 32)"
rest POST partner_api_keys "{\"organization_id\":\"$ORG_ID\",\"partner_id\":\"$PARTNER_ID\",\"label\":\"smoke\",\"key_prefix\":\"${PARTNER_KEY:0:15}\",\"key_hash\":\"$(printf %s "$PARTNER_KEY" | shasum -a 256 | cut -d' ' -f1)\"}" > /dev/null
papi() { # method route [auth] [body] [extra header]
  curl -s -m 120 -o /tmp/nhs-smoke-body -w '%{http_code}' -X "$1" "$BASE/partner-api/$2" \
    ${3:+-H "Authorization: $3"} ${4:+-H 'Content-Type: application/json' -d "$4"} ${5:+-H "$5"}
}
check "partner-api without a key" 401 "$(papi GET submissions)"
check "partner-api with a malformed key" 401 "$(papi GET submissions "Bearer nope")"
check "partner-api with an unknown key" 401 "$(papi GET submissions "Bearer nhs_pk_$(printf '0%.0s' {1..64})")"
check "partner-api from a browser" 403 "$(papi GET submissions "Bearer $PARTNER_KEY" "" "Origin: $WARD")"
check "partner-api unknown route" 404 "$(papi GET keys "Bearer $PARTNER_KEY")"
check "partner-api wrong method" 405 "$(papi POST submissions "Bearer $PARTNER_KEY")"
check "partner-api export" 200 "$(papi GET submissions "Bearer $PARTNER_KEY")"
check "partner-api export body" '{"partner":{"name":"Smoke Partner '"$RUN"' (synthetic)"},"has_more":false,"submissions":[],"next_since":null}' "$(cat /tmp/nhs-smoke-body)"
check "partner-api CSV header" "submission_id,partner_candidate_reference" "$(papi GET 'submissions?format=csv' "Bearer $PARTNER_KEY" > /dev/null; cut -d, -f1-2 /tmp/nhs-smoke-body | head -1 | tr -d '\r')"
check "partner-api bad since" 400 "$(papi GET 'submissions?since=yesterday' "Bearer $PARTNER_KEY")"
check "partner-api event without event_id" 422 "$(papi POST events "Bearer $PARTNER_KEY" '{"stage":"interview"}')"
check "partner-api event for an unknown submission" 422 "$(papi POST events "Bearer $PARTNER_KEY" '{"event_id":"smoke-1","submission_id":"00000000-0000-4000-8000-000000000000","stage":"interview"}')"
check "partner-api event invalid JSON" 400 "$(papi POST events "Bearer $PARTNER_KEY" '{')"

check "outbox without secret" 401 "$(curl -s -m 120 -o /dev/null -w '%{http_code}' -X POST "$BASE/process-outbox")"
check "outbox with secret" 200 "$(curl -s -m 120 -o /tmp/nhs-smoke-body -w '%{http_code}' -X POST "$BASE/process-outbox" -H "x-outbox-secret: $SECRET")"
echo "outbox summary: $(cat /tmp/nhs-smoke-body)"
check "outbox sent without failures" 0 "$(sed -E 's/.*"failed":([0-9]+).*/\1/' /tmp/nhs-smoke-body)"

rm -f /tmp/nhs-smoke-body
exit $fail
