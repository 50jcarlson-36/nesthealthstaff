# Intake API

## `POST /functions/v1/intake`

Public endpoint for clinician interest and facility staffing inquiries. It accepts
the same JSON body the live website already sends to its own `/api/leads`, so the
frontend can switch endpoints without changing the form.

- **Production URL** (once deployed): `https://fugzapgjowwwqgymcdbl.supabase.co/functions/v1/intake`
- **Local URL:** `http://127.0.0.1:55321/functions/v1/intake`
- **Auth:** none. No Supabase session or API key is needed.
- **CORS:** browser requests must come from an origin in `ALLOWED_ORIGINS`. Requests without an `Origin` header (server-to-server) are accepted.
- **Headers:** `Content-Type: application/json` is required. Send `Idempotency-Key: <8–200 printable chars>` if you want retries to be idempotent; it's optional but recommended.
- **Body limit:** 16 KB.

### Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `"nurse"` \| `"employer"` | yes | Also accepts `"clinician"` or `"facility"`. |
| `name` | string | yes | 2–160 characters. Whitespace is collapsed. |
| `email` | string | yes | Up to 254 characters. Stored lowercased. |
| `consent` | boolean | yes | Must be `true`. Also accepts `"on"`. |
| `phone` | string | no | Up to 40 characters. |
| `specialty` | string | no | Up to 80 characters. The live form's options are stored as-is. |
| `location` | string | no | Up to 160 characters. Stored as `preferred_location`. |
| `timeline` | string | no | One of the live form labels (*As soon as possible*, *Within 1–3 months*, *Within 3–6 months*, *Just exploring*) or a code (`asap`, `within_1_3_months`, `within_3_6_months`, `exploring`). |
| `organization` | string | employer only | Up to 200 characters. Required when `type` is `employer`. |
| `website` | string | no | Honeypot. Any non-empty value is answered with `200 {"ok":true}` and nothing is saved. |
| `housing_assistance_requested` | boolean | no | Not on the live form yet. |
| `staffing_type`, `headcount`, `desired_start_date`, `desired_end_date`, `staffing_requirements` | | no | Facility fields from the intake specification. They are not on the live form yet. Dates use `YYYY-MM-DD`. Headcount must be 1–1000. |

Unknown fields are ignored. The agency organization is resolved on the server from
`INTAKE_ORGANIZATION_SLUG`; any organization or role values a client sends are ignored.

### Responses

The live form treats any 2xx response as success and shows `error` on failure, so every error message is written to be shown to the visitor.

| Status | Body | When |
|---|---|---|
| `201` | `{"ok":true}` | Inquiry saved and notifications queued. |
| `200` | `{"ok":true}` | Duplicate: same `Idempotency-Key`, or an identical submission within 30 minutes. Also returned for honeypot hits. |
| `400` | `{"error":"…"}` | Validation failed. The message names the problem. |
| `403` | `{"error":"…"}` | Browser `Origin` is not allowed. |
| `405`, `413`, `415` | `{"error":"…"}` | Wrong method, body too large, or not JSON. |
| `429` | `{"error":"…"}` | Rate limited: more than 5 new submissions per client IP in 10 minutes, or more than 3 per email address per hour. |
| `500`, `503` | `{"error":"…"}` | Server or configuration error. Safe to retry with the same `Idempotency-Key`. |

Every response carries an `X-Request-Id` header that matches the function's logs. Logs never include submitted values.

### What a submission creates

All of the following happen in one database transaction (`public.submit_inquiry`):

1. A row in `inquiries` with stage `new`.
2. A `submitted` row in `inquiry_events`.
3. A `notification_outbox` row for the visitor confirmation (`clinician_inquiry_confirmation` or `facility_inquiry_confirmation`).
4. A second outbox row, `staff_new_inquiry_alert`, sent to the organization's `intake_notification_email` when that is set.

## `POST /functions/v1/process-outbox`

Internal. Sends due notifications. It requires the header `x-outbox-secret: <OUTBOX_PROCESSOR_SECRET>` and returns `{"provider", "claimed", "sent", "retrying", "failed", "lost"}`. Run it on a schedule (see [DEPLOYMENT.md](DEPLOYMENT.md)).

Delivery rules:
- Each row is claimed by one worker at a time.
- Failures that can be retried back off for 1, 2, 4 … up to 60 minutes, with at most 5 attempts.
- The outbox row id is sent to the email provider as its idempotency key, so a retry after a crash doesn't send the same email twice.

## Reading data from the portals

The portals read with the Supabase client, using the publishable/anon key and the signed-in user's session. Row Level Security decides what each user can see:

| Table | Who can read | Client writes |
|---|---|---|
| `organizations` | Members of that organization | none |
| `organization_memberships` | The user's own memberships; admins see their organization's | none: memberships are created only by server code |
| `profiles` | The user's own profile, plus colleagues in a shared organization | the user's own `full_name` and `phone` |
| `inquiries`, `inquiry_events` | Admins and recruiters of the owning organization | none yet: pipeline changes come in phase 2 |
| `notification_outbox`, `audit_events` | Admins of the owning organization | none |
| `intake_rate_limits` | nobody | none |
