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
| `201` | `{"ok":true,"reference":"<uuid>"}` | Inquiry saved and notifications queued. `reference` is the inquiry id, for support conversations. A retry that matches an earlier submission returns `200` with the same `reference`. |
| `200` | `{"ok":true,"reference":"<uuid>"}` | Duplicate: same `Idempotency-Key`, or an identical submission within 30 minutes. `reference` is the original inquiry. A honeypot hit returns `{"ok":true}` with no reference. |
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
| `inquiries`, `inquiry_events`, `inquiry_notes` | Admins and recruiters of the owning organization | none: changes go through the pipeline functions below |
| `jobs`, `job_internal_details`, `job_events`, `job_applications`, `application_events` | Admins and recruiters of the owning organization. `anon` has no table access. | none: changes go through the job functions below |
| `notification_outbox`, `audit_events` | Admins of the owning organization | none |
| `intake_rate_limits` | nobody | none |

## Staff pipeline functions (phase 2)

Called by signed-in staff through PostgREST (`supabase.rpc(...)`) with their own session. Each checks that the caller is an admin or recruiter of the inquiry's agency. All are `SECURITY DEFINER` with an empty `search_path`, and `anon` cannot execute them.

| Function | Arguments | Returns |
|---|---|---|
| `change_inquiry_stage` | `p_inquiry_id`, `p_expected_version`, `p_stage`, `p_closed_reason` (required for `closed`, rejected otherwise) | `{id, stage, closed_reason, version}` |
| `assign_inquiry` | `p_inquiry_id`, `p_expected_version`, `p_assignee_id` (a staff member of the same agency, or `null` to unassign) | `{id, assigned_recruiter_id, version}` |
| `add_inquiry_note` | `p_inquiry_id`, `p_body` (1–4,000 characters after trimming) | `{id, created_at}` |
| `organization_staff` | `p_organization_id` | rows of `{user_id, full_name, role}` |

Errors:

| Code | HTTP | Meaning |
|---|---|---|
| `PT400` | 400 | Invalid input. The message is written to be shown to staff. |
| `PT404` | 404 | The inquiry doesn't exist or belongs to another agency. Both cases look the same on purpose. |
| `PT409` | 409 | `p_expected_version` is stale. Reload the inquiry and retry. |
| `42501` | 401/403 | Not signed in. |

Every change writes an `inquiry_events` row (`stage_changed`, `assigned` or `note_added`) with the actor. Notes go to `inquiry_notes`, which staff can read but never edit or delete.

## Jobs and applications (phase 3)

A job is stored in two parts:

- **`jobs`**: fields that may be published. These are the title, specialty, employment type, city, state, shift, hours, start date, duration, openings and public description.
- **`job_internal_details`**: what stays inside the agency. This is the facility, contact, source, requisition reference, rate notes and internal notes.

Staff send both parts as separate JSON objects. Each function reads only the keys it expects from each object, so an internal field sent in the public object is ignored, not published. Pay is internal only for now (see STATUS.md, "Publishing constraint").

### Public

| Function | Who | Arguments | Returns |
|---|---|---|---|
| `list_public_jobs` | `anon`, `authenticated` | `p_organization_slug` | Open jobs only, newest first, at most 500, with public columns only: `{id, title, specialty, employment_type, city, state, shift, hours_per_week, start_date, duration_weeks, openings, public_description, published_at}` |
| `submit_job_application` | `service_role` only | `p_organization_slug`, `p_job_id`, `p_application` (`full_name`, `email`, `phone`, `consent_version`), `p_client_hash` | `{status: "created" \| "duplicate" \| "job_closed" \| "job_not_found" \| "rate_limited", application_id?}` |

There's one application per person per job: the same email (in any case) returns `duplicate` with the original id, even when submissions arrive at the same moment. A job that isn't `open` returns `job_closed`. A shared lock on the job means a status change can't land partway through a submission. The public `apply` Edge Function below is the only caller.

### Staff

These are called with the staff member's own session, like the pipeline functions above, and use the same error codes.

| Function | Arguments | Returns |
|---|---|---|
| `create_job` | `p_organization_id` (checked against the caller's memberships), `p_job`, `p_internal` | `{id, status: "draft", version}` |
| `update_job` | `p_job_id`, `p_expected_version`, `p_job`, `p_internal` (replaces every editable field; `PT400 "Nothing changed"` if nothing did) | `{id, version}` |
| `set_job_status` | `p_job_id`, `p_expected_version`, `p_status` (`draft`, `open`, `on_hold`, `filled`, `closed`) | `{id, status, published_at, version}` |
| `add_application_from_inquiry` | `p_job_id` (must be open), `p_inquiry_id` (a clinician inquiry from the same agency; name, email and phone are copied from it) | `{id}` |
| `change_application_stage` | `p_application_id`, `p_expected_version`, `p_stage` (`applied`, `screening`, `submitted`, `offered`, `hired`, `rejected`, `withdrawn`), `p_reason` (required for `rejected` and `withdrawn`, refused otherwise) | `{id, stage, stage_reason, version}` |

How job status works:

- Opening a job sets `published_at` the first time. After that, the job can't go back to `draft`.
- Every status other than `open` hides the job from the listing and refuses new applications. Existing applications are kept.

History:

- `job_events` records `created`, `status_changed`, and `updated`. An `updated` event lists the names of the changed fields, never their values.
- `application_events` records `created` and `stage_changed`.

## `POST /functions/v1/apply`

Public job applications. This endpoint works like `intake`:

- **Origin:** browsers must send an allowed `Origin`. Server-to-server callers send none.
- **Content type:** `Content-Type: application/json` is required.
- **No session needed:** the website calls it without a Supabase session.
- **Size limit:** the body is limited to 8 KB.
- **Errors:** `{"error": "<message safe to show>"}`.

The job must be open and must belong to the organization set in `INTAKE_ORGANIZATION_SLUG`. Get job ids from `list_public_jobs`.

### Request body

```json
{
  "job_id": "0e16d69e-0a81-405a-8a60-de42b9a9eb79",
  "name": "Pat Example",
  "email": "pat@example.com",
  "phone": "555-0100",
  "consent": true,
  "website": ""
}
```

| Field | Rules |
|---|---|
| `job_id` | Required. A UUID. |
| `name` (or `full_name`) | Required. 2–160 characters after whitespace is collapsed. |
| `email` | Required. A valid address, stored in lowercase. |
| `phone` | Optional. Up to 40 characters. |
| `consent` | Required. Must be `true` (or `"true"`, `"on"`, `"yes"`). Stored as consent version `2026-10-apply-v1`. |
| `website` | Honeypot. Leave it empty. |

Any other field is dropped. Applications collect contact details only: no résumé, licence number or free text.

### Responses

| Status | Body | When |
|---|---|---|
| `201` | `{"ok": true}` | Saved |
| `200` | `{"ok": true}` | This email already applied to this job (in any capitalization), or the honeypot was filled. Nothing new is saved. |
| `400` | error | Validation failed. The message names the problem. |
| `403` | error | `Origin` isn't allowed |
| `404` | error | The job doesn't exist, or belongs to another agency |
| `405` / `413` / `415` | error | Wrong method, body over 8 KB, or not JSON |
| `409` | `{"error": "This job is no longer taking applications."}` | The job is draft, on hold, filled or closed |
| `429` | error | More than 10 applications from one client in 10 minutes. The client IP is hashed with `INTAKE_IP_HASH_SECRET`. |
| `500` / `503` | error | Server error, or the function isn't configured |

Each saved application appears in ward under its job with stage `applied`. Two emails are queued in the same transaction:

- `job_application_confirmation` goes to the applicant.
- `staff_new_application_alert` goes to the agency's `intake_notification_email`, if one is set, and links to the job in ward.

Neither email contains applicant details, and neither contains internal job fields. A duplicate, a closed or unknown job, or a rate-limited request queues nothing. A candidate a recruiter puts forward from an inquiry gets no email, because they didn't apply themselves. Outbox rows carry `application_id`.

## Staff invitations and team management

An agency admin invites someone from ward's Team page. The invitation email holds no sign-in token: it sends the person to ward, where they ask for an ordinary magic link for that address. Access is granted only after that sign-in, when ward calls `accept_staff_invitations`. That function matches pending invitations against the signed-in user's own confirmed email in `auth.users`, never an address the client sends.

### `POST /functions/v1/staff-invite`

Called by ward with the admin's session (`supabase.functions.invoke`). Only the ward origin (`ADMIN_PORTAL_URL`) is allowed. The function identifies the caller with `auth.getUser`, then calls `invite_staff` (service role only), which checks they're an admin of the organization before writing anything. Only then does it create the invitee's login, confirmed and with no password, so ward's sign-in, which never creates accounts, can email them a link. An existing login is reused.

Body (JSON, at most 4 KB):

| Field | Required | Notes |
|---|---|---|
| `organization_id` | yes | UUID of an agency the caller is an admin of |
| `email` | yes | Lowercased and trimmed |
| `full_name` | no | Up to 160 characters. Copied to the person's profile on acceptance if they have no name yet. |
| `role` | yes | `admin` or `recruiter` |

| Status | Body | Meaning |
|---|---|---|
| 201 | `{"ok":true,"status":"created","invitation_id","expires_at"}` | Invitation saved and email queued |
| 200 | `{"ok":true,"status":"resent",...}` | An open invitation for that address was updated (role, name), extended to 14 days and sent again. At most five sends. |
| 400 | `{"error": "<message safe to show>"}` | Invalid input, already on staff, or sent five times |
| 401 | `{"error": ...}` | No session or an invalid one |
| 403 | `{"error": ...}` | Not an admin of that agency, or a request from another origin |
| 405, 413, 415 | `{"error": ...}` | Wrong method, body too large, not JSON |
| 502 | `{"error": ...}` | The invitation is saved but the login couldn't be created. Sending it again retries. |

### Database functions

Called with the admin's own session through PostgREST, except `invite_staff`.

| Function | Who | Arguments | Returns |
|---|---|---|---|
| `invite_staff` | service role (the function above) | `p_actor_id`, `p_organization_id`, `p_email`, `p_full_name`, `p_role` | `{status, invitation_id, email, expires_at}` |
| `revoke_staff_invitation` | admin | `p_invitation_id` | `{id}`. Also cancels the invitation email if it hasn't been sent. |
| `accept_staff_invitations` | any signed-in user | none | `{accepted}`: how many invitations became memberships. An existing membership keeps its role. |
| `organization_members` | admin | `p_organization_id` | rows of `{user_id, full_name, email, role, joined_at, last_sign_in_at}` |
| `change_staff_role` | admin | `p_organization_id`, `p_user_id`, `p_role` | `{user_id, role}`. Refused if it would leave the agency with no admin. |
| `remove_staff_member` | admin | `p_organization_id`, `p_user_id` | `{user_id, unassigned_inquiries}`. Access ends at once; their inquiries in that agency are unassigned (logged as `assigned` events with reason `staff_removed`). Admins can't remove themselves. The login itself is kept. |

Errors: `PT400` invalid input (message safe to show), `PT403` not an admin (from `invite_staff`), `PT404` not found or another agency's. Admins can read their agency's `staff_invitations`; recruiters can't. Every invitation, acceptance, revocation, role change and removal writes an `audit_events` row.

The `staff_invitation` email names the agency, the role, the inviter and the expiry date, and links to ward's sign-in page.

## Partners, consent and attribution (recruiting-only model)

Nest sources and screens candidates and submits them to **partner agencies'** authorized openings. The partner employs, credentials and pays the clinician and contracts with the facility. Nest stores no credential documents and no payroll data.

### Partners and opening terms (staff, own session)

| Function | Who | Arguments | Notes |
|---|---|---|---|
| `create_partner` | admin | `p_organization_id`, `p_partner` | Fields: name, status (`prospect`, `applying`, `active`, `paused`, `ended`), contact, `agreement_signed_on`, eligibility, fee terms, payment timing, extension/cancellation/refund terms, `attribution_days` (1–730), duplicate rules, `may_advertise`, advertising terms, `data_transfer_method` (`manual`, `csv`, `api`, `ats_export`), notes. Active needs an agreement date; advertising needs recorded terms. |
| `update_partner` | admin | `p_partner_id`, `p_expected_version`, `p_partner` | `PT409` on a stale version |
| `set_job_terms` | staff | `p_job_id`, `p_expected_version` (the job's), `p_terms` | Partner and their reference, priority (`normal`, `high`, `critical`), strike (`is_strike`, dates, union, notes), pay in cents (hourly, weekly gross, housing and meals stipends, crisis rate), incentives in cents (sign-on, completion, extension, referral, Nest's own). Bumps the job's version. |

Staff read `partners`, `job_partner_terms`, `partner_submissions` and `submission_consents` (without `token_hash`) for their agency.

**Job board rule:** `list_public_jobs` now also returns `is_strike`, and shows a partner's opening only while that partner is `active` and `may_advertise`. A website application to an opening the public can't see gets `job_not_found`. Pay and incentives are never public.

### Consent

| Function | Who | Notes |
|---|---|---|
| `request_submission_consent(p_application_id)` | staff | Needs an active partner on the opening. Snapshots the exact wording (`submission-v1`, or `submission-strike-v1` for a strike assignment, which names the strike and its dates), stores only the SHA-256 of a 64-hex link token, and queues the `submission_consent_request` email with the token. A new request revokes the pending one and cancels its unsent email. Expires after 7 days. |
| `revoke_submission_consent(p_consent_id)` | staff | Pending requests only |
| `view_submission_consent(p_token)` | service role | Returns the wording, partner, job title and city; nothing else about the candidate |
| `respond_submission_consent(p_token, p_decision, p_client_hash)` | service role | `granted` or `declined`, once. A second answer returns the first with `already_answered: true`. |

The token is removed from the outbox row as soon as the email is sent, fails or is cancelled, so admins reading the outbox can't use a link. The email links to `<ward>/consent#<token>`: the fragment never reaches a server.

**`POST /functions/v1/consent`** (public, ward origin only): body `{"token": "<64 hex>", "action": "view" | "granted" | "declined"}`, at most 1 KB. Replies `200` with the consent or the answer's status, `404` for an unknown or malformed link, `403` from another origin, `405` for other methods.

### Submissions and attribution

| Function | Who | Notes |
|---|---|---|
| `submit_to_partner(p_application_id, p_partner_candidate_reference)` | staff | Needs an active partner with `attribution_days` set, and a granted consent for this application and partner (one that names the strike for a strike assignment). Records the submission with `attribution_expires_on` = today + the partner's period, moves the application to `submitted` if it was earlier, and returns `prior_live_submissions`: how many live submissions of the same person to the same partner are still inside attribution. One live submission per application. |
| `update_partner_submission(p_submission_id, p_expected_version, p_status, p_reason)` | staff | `withdrawn` or `partner_duplicate`, with a reason |

Every request, answer, cancellation and submission writes an `application_events` row.

**Pending legal review:** the consent wording, especially the strike paragraph, and whether it should name the legal entity (Nest Staffing, LLC) rather than the agency's display name.

## Candidate journeys

One journey per open application on a partner opening: where the candidate stands, what's missing, and what should happen next.

**Stages** (on `partner_submissions.stage`): `submitted`, `partner_review`, `interview`, `offer`, `offer_accepted`, `credentialing`, `cleared_to_start`, `started`, `extended`, `completed`, `declined`, `cancelled`. Before a submission exists, the journey follows the consent (not asked, awaiting approval, approved).

| Function | Who | Notes |
|---|---|---|
| `update_journey_stage(p_submission_id, p_expected_version, p_stage, p_note, p_start_on, p_end_on)` | staff | `declined` and `cancelled` need a reason; `started`, `extended` and `completed` need an assignment start date. Dates are kept when not given. Moves the application to `offered` (offer through cleared to start) or `hired` (started onward), logging both changes. |
| `add_journey_item(p_application_id, p_title, p_owner, p_due_on, p_note)` | staff | Owner is `nest`, `partner` or `candidate`. Records that an item exists and its status, never the document. |
| `set_journey_item_status(p_item_id, p_expected_version, p_status, p_note)` | staff | `received`, `waived` (needs a reason) or back to `needed` |
| `set_partner_requirements(p_partner_id, p_requirements)` | admin | Replaces the partner's standard items: `[{title, owner, due_days_before_start}]`, up to 50. They're copied onto a candidate's checklist when the candidate is submitted, due that many days before the job's start date, skipping titles already on the checklist. |

**`journey_overview`** (view, staff's own agency through RLS): per open application on a partner opening, the partner, strike and priority flags, consent and journey stage, assignment dates, `missing_items`, `next_action`, `next_action_due` and `overdue` (the due date has passed or a needed item is past due). Next actions and their due dates:

| Where it stands | Next action | Due |
|---|---|---|
| Not asked / expired / revoked | Ask the candidate for approval (again) | today |
| Approval pending | Waiting for the candidate's approval | when the link expires |
| Approved | Record the submission (or ask again if a strike consent is missing) | today |
| Submitted | Chase the partner for a review | 3 days after the stage changed |
| Partner review | Chase the partner for a decision | 5 days |
| Interview | Get interview feedback | 2 days |
| Offer / offer accepted | Confirm the offer / start credentialing | 2 days |
| Credentialing | Collect N missing items, or confirm clearance | earliest item due, else 5 days |
| Cleared to start | Check in before the start date | 3 days before start |
| Started / extended | Plan the next assignment (within 6 weeks of the end), else check in | 4 weeks before the end, else every 2 weeks |

## Partner connector

How candidates and progress move between Nest and a partner's ATS. A partner only ever sees and changes its own submissions. Every update, applied or not, is logged in `partner_events`. Exports are logged in `audit_events` (`partner_export`, `partner_api_export`).

### API keys (admins, own session)

- `create_partner_api_key(p_partner_id, p_label)` returns `{id, key, key_prefix}`. The key (`nhs_pk_` plus 64 hex characters) is shown once; only its SHA-256 hash is stored. The partner must be active, and can have two live keys at most, so one can replace the other.
- `revoke_partner_api_key(p_key_id)`.
- Keys stop working when revoked, or when the partner is no longer active or paused.
- Staff read `partner_api_keys` without `key_hash`.

### `GET /functions/v1/partner-api/submissions`

Server-to-server, with `Authorization: Bearer nhs_pk_...`. Requests with an `Origin` header (browsers) are refused with `403`.

Query: `since` (ISO 8601; rows changed at or after it), `limit` (1–1000, default 500), `format` (`json` or `csv`).

The JSON reply is `{partner: {name}, submissions: [...], has_more, next_since}`. To page, pass the last row's `updated_at` (also in `next_since`) as `since`; that row comes back again, so de-duplicate on `submission_id`. CSV replies carry `X-Has-More` and `X-Next-Since` headers.

Each submission has:
- `submission_id`, `partner_candidate_reference`, `status`, `submitted_at`, `attribution_expires_on`;
- `stage`, `stage_updated_at`, `assignment_start_on`, `assignment_end_on`;
- `candidate`: `{full_name, email, phone}`, or `null` once the submission is withdrawn or reported as a duplicate;
- `job`: `id`, `title`, `specialty`, `city`, `state`, `shift`, `start_date`, `duration_weeks`, `partner_job_reference` and `is_strike`;
- `checklist`: `[{title, owner, status, due_on}]`;
- `updated_at`.

Pay terms, incentives, facility details and internal notes are never included. CSV cells that a spreadsheet would run as formulas are prefixed with `'`.

### `POST /functions/v1/partner-api/events`

One update as JSON, up to 16 KB:

```json
{
  "event_id": "ats-evt-8812",
  "occurred_at": "2026-11-02T15:04:00Z",
  "submission_id": "…",
  "partner_candidate_reference": "ATS-123",
  "stage": "credentialing",
  "assignment_start_on": "2026-12-01",
  "assignment_end_on": "2027-03-01",
  "note": "Offer accepted by phone",
  "items": [{"title": "TB test", "status": "received"}, {"title": "Drug screen", "status": "needed", "owner": "candidate", "due_on": "2026-11-20"}]
}
```

- **`event_id` (required):** up to 100 characters. An event already accepted returns `duplicate` and changes nothing. A rejected event's id isn't kept, so the partner can fix the event and resend it with the same id.
- **Which submission:**
  - `submission_id` from the export, or the partner's own `partner_candidate_reference`. A reference must match exactly one open submission.
  - If both are given, the reference is saved for later events.
- **`stage`:** one of `submitted`, `partner_review`, `interview`, `offer`, `offer_accepted`, `credentialing`, `cleared_to_start`, `started`, `extended`, `completed`, `declined`, `cancelled`. Labels like "Partner review" are accepted.
  - `started`, `extended` and `completed` need a start date.
  - `declined` and `cancelled` without a note record "Reported by <partner>".
  - The application's own stage follows, as with staff changes.
- **`occurred_at` (optional):** a stage change older than the one already recorded is skipped as `stale`.
- **`items`:**
  - Matched to the checklist by title, ignoring case. Items that don't exist yet are added, owned by the partner unless `owner` says otherwise.
  - `status` is `needed`, `received` or `waived`. Waiving without a note records "Waived by <partner>".
  - The checklist records only that an item exists, never a document.

Replies:
- `200` `{result: "applied" | "unchanged" | "stale" | "duplicate", submission_id, changes}`;
- `422` `{result: "rejected", error}`. A rejected event changes nothing;
- `401` missing or unknown key; `400` invalid JSON; `413`; `415`.

### Ward (staff, own session)

- `export_partner_submissions(p_partner_id, p_since)`: the same rows as the API, up to 5000. Ward downloads them as CSV or JSON.
- `import_partner_updates(p_partner_id, p_rows, p_dry_run)`:
  - `p_rows` holds up to 500 update objects, shaped like API events but without `event_id`. Ward reads them from the partner's CSV.
  - A dry run returns each row's result and changes nothing.
  - Results are `{dry_run, counts, rows: [{row, result, error?, submission_id?, changes?}]}`.
- **CSV columns (headers ignore case and punctuation):**
  - `submission_id`, or `partner_candidate_reference` (also `reference` or `candidate id`);
  - `stage`, or `status` when there's no `stage` column;
  - `assignment_start_on` / `start date`, `assignment_end_on` / `end date`, `note`;
  - `item`, `item_status`, `item_owner`, `item_due_on`, `item_note`.

  Other columns are ignored and listed, so the partner can edit our export and send it back.
- Staff read `partner_events` for the partner's recent updates.
