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
