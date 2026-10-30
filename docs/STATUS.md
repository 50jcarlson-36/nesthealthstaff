# Status report

Last updated 2026-10-29, checked against production read-only on that date. Repo and test data is synthetic, using `@example.com` addresses. Production holds only labeled test records addressed to `@nesthealthstaff.com`: 3 inquiries, 7 sent notifications, 1 staff user. No real applicant data exists.

## What's live

| Piece | Where | State |
|---|---|---|
| Database | Supabase `fugzapgjowwwqgymcdbl` | All 8 migrations applied (staff invitations added 2026-10-29). Organization `nest-health-staff`, alerts to `recruiting@nesthealthstaff.com`. |
| Edge Functions | same project | `intake` v6, `apply` v5, `process-outbox` v8, `staff-invite` v1, all `verify_jwt` off. `process-outbox` v8 and `staff-invite` v1 are deployed from commit `091f422`. |
| Outbox worker | `pg_cron` job `nest-inquiry-notifications` | Runs every minute. In the 24 hours to 2026-10-29 20:10 UTC: 946 runs succeeded, 0 failed, 0 non-`200` responses. |
| Email | Resend | Sends as `Nest Health Staff <no-reply@nesthealthstaff.com>`, replies to `recruiting@`. All 7 outbox rows are `sent` through Resend. The owner confirmed receipt. DMARC (`p=none`) is published. |
| Staff app | `ward.nesthealthstaff.com` (Worker `nest-ward`, version `72c23bb9`) | Sign-in verified. 1 user (`50jcarlson@gmail.com`, admin). Team page (staff invites) deployed 2026-10-29. |
| Website | `nesthealthstaff.com` (Sites) | Inquiry forms call `intake` (see Integrations). No job board or apply form yet. |

## Delivery phases

| Phase | State |
|---|---|
| 1. Intake: submit → inquiry saved → notifications queued | **Live.** The website's clinician and facility forms send to the hosted `intake`; 3 test inquiries (2 clinician, 1 facility, source `website`) arrived on 2026-10-29 with idempotency keys, and their notifications were delivered through Resend. |
| 2. Staff: sign in → review → update pipeline | **Live.** Database functions `change_inquiry_stage`, `assign_inquiry`, `add_inquiry_note` and `organization_staff` handle stage changes (a reason is required to close), recruiter assignment (same-agency staff only) and append-only notes. Stage and assignment changes use optimistic concurrency via `version`. Ward exposes all of it. One admin exists. **Staff invites: deployed 2026-10-29, not yet used in production.** Admins invite people from ward's Team page through the `staff-invite` Edge Function; access starts when the invitee signs in with that address. Admins can also resend or revoke invitations, change roles and remove staff, and the agency always keeps an admin. Tested locally end to end, including in a browser. In production, checked without writing anything: `staff-invite` allows only the ward origin (`403` from the public site), refuses no or bad sessions (`401`) and GET (`405`); `invite_staff` can't be called by `anon` or `authenticated`; 0 invitations exist. The signed-in Team page hasn't been viewed in production yet. |
| 3. Recruiting: jobs, applications | **Backend and ward live; website not connected.** Recruiters enter jobs by hand in `ward.`. Each job is stored in two parts: public fields in `jobs`, and facility, requisition, rates and notes in `job_internal_details`, which only staff can read. The public listing reads only open jobs, through `list_public_jobs`, and only their public columns. Applications go in `job_applications`, from the website via the `apply` function, or from a recruiter putting forward a clinician inquiry. New website applications queue an applicant confirmation and a staff alert. Pay is internal only until the supplier agreements say otherwise. Production has 0 jobs and 0 applications. **Not built yet:** the job board and apply form on the website. |
| 3b. Partner model: partners, consent, attribution | **Built and tested locally, not deployed.** Nest is a recruiting-only sourcing partner: partner agencies employ, credential and pay. Partners and their agreed terms (fees, attribution period, duplicate rules, advertising permission, transfer method); per-opening partner, strike, pay and incentive terms (internal; only a strike label is public); candidate consent through a single-use emailed link to ward's `/consent` page, with strike assignments needing a consent that names the strike; and submissions recorded with an attribution expiry. A partner's openings reach the job board only with advertising permission. Checked end to end in a browser against the local stack. **Pending:** legal review of the consent wording, especially strike work. |
| 4. Onboarding: profiles, private documents | **Replaced by the partner model:** credentialing documents stay with partner agencies, so Nest doesn't collect them. |
| 5. Placement: assignments, housing | Not started |

## Integrations

| Connection | Status | Evidence / source | Next action | Blocker |
|---|---|---|---|---|
| Supabase database (hosted `fugzapgjowwwqgymcdbl`) | **Verified working** | Deployed 2026-10-28 with the owner's explicit approval (`db push`, no seed data). The schedule migration `20261029043156` was applied on 2026-10-29. Checked 2026-10-29: 7 migrations, 1 organization, 1 user, 1 membership. Earlier write-free checks: `intake` preflight `204`, foreign origin `403`, GET `405`; `apply` unknown job `404`, form body `415`; `process-outbox` without secret `401`; `anon` refused (`42501`) on `inquiries`, `job_internal_details`, `organizations` and `submit_job_application`. Advisors report no errors; the warnings are intended (`list_public_jobs` open to `anon`; staff functions open to `authenticated` and checking membership themselves; two tables with two permissive read policies). | n/a | n/a |
| Supabase local stack | See the test results below | `supabase start` on ports 553xx | n/a | n/a |
| Supabase Auth | **Verified working** | Site URL `https://nesthealthstaff.com`; the only redirect URL is `https://ward.nesthealthstaff.com/**` (set 2026-10-28 by `config push`, with the owner's approval). Magic-link sign-in to ward verified 2026-10-29 02:54 UTC. On 2026-10-29, with the owner's approval: **public signups turned off**, and **Auth emails sent through Resend SMTP** from `no-reply@nesthealthstaff.com` with a sending-only key, limit 30 an hour (was 2). Turning off `[auth.email] enable_signup` also turned off email sign-in for about an hour; it was switched back on and verified. Checked afterwards: live settings show signups off and the email provider on; `/signup`, and `/otp` creating a user, both return `signup_disabled` with no account created; a sign-in link to the admin address at 23:32 UTC returned `200`, so Resend accepted it. **Sign-in through the new sender verified:** the owner signed out of ward, requested a link with the form, and signed in from the email; the auth tables show a new session at 23:43:15 UTC. | n/a | n/a |
| Supabase Storage (private documents) | **Deferred** to phase 4 | n/a | n/a | n/a |
| Website → `intake` | **Connected (reported), data consistent** | Another session reported on 2026-10-29 that the website's inquiry forms now call the hosted `intake` before reporting success, with a stable `Idempotency-Key` per submission, and that nurse and facility submissions appeared in ward with matching receipt IDs. The website keeps a legacy D1 copy for job and referral reporting; ward is authoritative. The website source isn't in this repo, so this was not re-tested here. Production data matches: 3 inquiries with source `website`, consent version `2026-10-website-v1` and idempotency keys. | Add the job board and apply form, calling `list_public_jobs` and `apply` | The website source lives outside this repo |
| Email inboxes: Zoho Mail | **Set up; receipt verified for `jcarlson@`** | In the Zoho organization `mowmatter` (Mail Lite plan, 1 licence), `nesthealthstaff.com` is "Verified". Public DNS has the Zoho MX records, SPF `include:zohomail.com` and DKIM selector `zmail`. Aliases on the one mailbox, `jcarlson@mowmatter.com`: `recruiting@`, `hello@`, `privacy@`, `dmarc@` and `jcarlson@`. `postmaster@` and `abuse@` are on the group "Nest Health Staff Postmaster", since Zoho refuses them as user aliases. The Resend test email reached `jcarlson@`; the other addresses haven't had a test message. | DMARC is live (2026-10-29): `_dmarc` TXT `v=DMARC1; p=none; rua=mailto:dmarc@nesthealthstaff.com`, returned by Cloudflare's nameserver, 1.1.1.1 and 8.8.8.8. Reports go to `dmarc@`. After about two weeks of clean reports, consider `p=quarantine`. | n/a |
| Email sending: Resend | **Verified working** | Domain `nesthealthstaff.com` Verified in Resend; `send.` and `rsend.` CNAMEs to `forge.rmta.net` and the `resend._domainkey` DKIM key are live. Secrets: `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM=Nest Health Staff <no-reply@nesthealthstaff.com>`, `EMAIL_REPLY_TO=recruiting@nesthealthstaff.com`. The adapter sends the outbox row id as `Idempotency-Key`. The approved test email to `jcarlson@nesthealthstaff.com` (2026-10-29 13:44 UTC) arrived. DMARC `p=none` published 2026-10-29. | Review DMARC reports, then tighten the policy | n/a |
| Email sending: Zoho Mail API | **Built, not connected** | Committed in `0fa9093`. `EMAIL_PROVIDER=zoho` sends through a Zoho mailbox with an OAuth refresh token. Zoho documents no idempotency key, so an unknown send outcome is failed for manual reconciliation, never retried. Secrets `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET` and `ZOHO_REFRESH_TOKEN` exist; `ZOHO_ACCOUNT_ID` doesn't. Tested only with fakes. | Only if switching from Resend: set `ZOHO_ACCOUNT_ID` and test against Zoho | Not needed while Resend works |
| Domain `nesthealthstaff.com` | **Verified working** | Checked 2026-10-28: Cloudflare is the registrar and nameservers (`kellen`/`raphaela.ns.cloudflare.com`). The apex and `www` (CNAME `custom-domains.chatgpt.site`) both return `200` over valid HTTPS and serve the Sites frontend. Apex rechecked `200` on 2026-10-29. | Optionally redirect `www` to the apex, so there's one canonical host | n/a |
| `ward.nesthealthstaff.com` | **Verified working** | Worker `nest-ward` in Cloudflare account "50jcarlson@gmail.com's Account", with a custom-domain route; current version `72c23bb9`, deployed 2026-10-29 from commit `6ed43cd` with the Nest Health Staff design (branded sign-in, sidebar, inquiry metrics and search). HTTPS and deep links return `200`. Headers: CSP naming only `fugzapgjowwwqgymcdbl`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`, `nosniff`; `robots.txt` disallows everything. The bundle holds the publishable key only. The first sign-in failed because ward sent `emailRedirectTo` without a trailing slash, which doesn't match the allow-list glob; fixed in `8f196d3e` and verified. The only console error is Cloudflare Web Analytics' injected beacon, which the CSP blocks. | Optionally turn off automatic Web Analytics for this hostname. | n/a |
| Subdomains `staff.`, `employers.` | **Not live** | Checked 2026-10-28: neither has a DNS record. Hosting is decided: Cloudflare Workers, like ward. | Build them | Phase 4 |
| NurseRecruiter.com: **jobs in** | **Unverified (not offered)** | The [API docs](https://api.nurserecruiter.com/) (checked 2026-10-28) document only `GET /v1/candidates` and `GET /v1/resume/{id}`. There's no jobs endpoint or job feed. The site lets employers *post* jobs there. | Ask NurseRecruiter whether a job feed or partner syndication exists | No documented route |
| NurseRecruiter.com: candidates in | **Access required** | The same docs describe Bearer-token auth, issued "once your integration is enabled". Up to 100 candidates per page, filterable by acquisition date. Rate limits and webhooks aren't documented. | Needs an employer account with the integration enabled. Importing resumes also needs phase 4 private document storage. | No account or token |
| SMS: Twilio | **Deferred** | n/a | The outbox `channel` column can take SMS later | n/a |
| Billing: Stripe | **Deferred** | n/a | n/a | Business-model decision |
| Housing: Extended Stay, Marriott, Hilton | **Unverified** | Not researched yet. No relationships exist. | Research official partner and affiliate routes (phase 5) | n/a |
| License verification: **Nursys e-Notify** (NCSBN) | **Available, not connected** | Researched 2026-10-28 from [NCSBN's institution page](https://www.ncsbn.org/456.htm) and vendor integration guides ([Credentially](https://intercom.help/credentially/en/articles/6015723-how-to-configure-nursys-e-verify-integration), [Modio](https://www.modiohealth.com/life/wp-content/uploads/NURSYS-TIP-GUIDE-July-2025.pdf)). It's free for U.S. institutions and sends licence status and public discipline updates for enrolled nurses. Vendor guides say the API credentials come from the institution's own e-Notify account (the first password is requested from Nursys support by phone), and that enrolling a nurse needs licence number and state, with some integrations also sending SSN and date of birth. Some state boards aren't covered. The official API specification wasn't publicly available to check. | Register the agency as an e-Notify institution and get the API specification from Nursys | No account. Phase 4 would need encrypted storage for any SSN or date of birth. |
| "Digital Onboarding" (`docs.digitalonboarding.com`) | **Not applicable** | Checked 2026-10-28: it's a customer-engagement platform for banks and credit unions. Its API documents contacts, accounts, templates and journeys. It does **not** document `/v1/nurses`, `/v1/credentials/verify`, `/v1/journeys/assign` or `/v1/ehr/users`, which were described to us as its endpoints. | None | n/a |
| Background checks, e-signature, payroll | **Deferred** | n/a | n/a | Providers not chosen |

## Job listing sources (researched 2026-10-28)

How it works: hospitals buy travel and contract nurses through direct agency contracts, or through a **vendor management system (VMS)**, often run by a **managed service provider (MSP)**. Job orders go only to agencies approved as suppliers on that program. We found **no public feed** of travel-nurse job orders that an agency can subscribe to. Every route below starts with a business agreement, not an API key.

Most sources below are vendor pages and trade press, not program documentation. Exact supplier requirements and API terms come from each program once you start the supplier process.

| Source | What it gives us | Status | Access requirements | Next action |
|---|---|---|---|---|
| **Direct facility contracts** | Job orders straight from a hospital, which a recruiter enters in `ward.` | **Available, not connected.** Job entry is live in ward; no real facility contract exists yet. | A signed staffing agreement with each facility | Sign the first facility. This is the first-release path. |
| **AMN ShiftWise Flex** (VMS) | Open requisitions from hospitals using it | **Access required** | Approval as a supplier in AMN's network (1,100+ suppliers). AMN says suppliers can connect their ATS and payroll by API. No public application page was found. | Contact AMN's supplier relations. [Product page](https://amnhealthcare.com/technology/workforce/vendor-management-systems/shiftwise-flex) |
| **Medefis** (VMS with managed service, owned by AMN) | Requisitions from its client hospitals | **Access required** | A Medefis-vetted agency. The route for new suppliers isn't published. | Contact Medefis or AMN business development. [Overview](https://www.allhealthinc.com/strategic-business-partner/medefis) |
| **Aya LotusOne** (formerly Aya Connect VMS) | Requisitions from hospitals using Aya's platform | **Unverified** | No supplier registration documentation was found | Ask Aya about subcontractor/supplier access. [Sales sheet](https://www.ayahealthcare.com/wp-content/uploads/sites/2/2025/06/LotusOne_Aya_DigitalPlatform_SalesSheet.pdf) |
| **Hallmark Total Vendor Management** (VMS) | Requisitions, with candidate submission through Vivian's integration | **Unverified** | Supplier approval on Hallmark programs | Ask Hallmark about supplier onboarding. [Announcement](https://hitconsultant.net/2025/10/31/vivian-health-and-hallmark-partner-to-integrate-ai-hiring-tech-for-healthcare-staffing/) |
| **VMS job-order aggregators** (JobRobotix JobSource, LaborEdge Nexus ATS) | Pull requisitions from the VMS portals we're approved on into a single feed | **Unverified**, and only useful after supplier approval | A commercial subscription plus our own VMS logins. Neither publishes a job API for third parties. | Revisit once we're on at least one VMS. [JobRobotix + LaborEdge](https://jobrobotix.com/?p=4074) |
| **Vivian Health** | **Distribution, not a source.** A marketplace where agencies *post* jobs to reach nurses. | **Unverified** | Agency partner account. Feed format undocumented in public sources. | Consider later as an outbound channel |
| **NurseRecruiter.com** | No jobs, only candidates and resumes (see the table above) | **Unverified (not offered)** | n/a | n/a |

**Publishing constraint (unverified):** VMS job orders are supplied to approved vendors under program terms. Whether we may show them publicly, including the facility name, pay rates and the hospital's own description, has to be checked in each supplier agreement before anything flows to our public job board. The jobs schema should therefore keep internal job-order details separate from the fields we publish.

**Recommended order:**
1. In phase 3, recruiters enter jobs manually in `ward.` from direct facility contracts.
2. Apply for supplier status on one or two VMS programs.
3. Add an aggregator or a VMS API only once those agreements allow it.

## Required verification items

| # | Item | State |
|---|---|---|
| 1 | Intake saves an inquiry and queues notifications | Test written (`tests/integration/intake-and-access.test.ts`) |
| 2 | Anonymous users cannot read private inquiries or profiles | Test written |
| 3 | Clinicians can't access other clinicians' documents or applications | Phase 4. Clinician accounts don't exist yet. Today only staff of the owning agency can read applications (tested in `jobs.test.ts`). |
| 4 | Recruiters cannot access another organization's records | Test written |
| 5 | Facility users cannot access unrelated facilities | Phase 3 (facility memberships aren't built yet) |
| 6 | Users cannot promote themselves or change protected fields | Test written |
| 2b | Pipeline changes are validated, scoped to the agency and safe under concurrency | Test written (`tests/integration/pipeline.test.ts`) |
| 3b | Internal job fields never reach the public listing | Test written: internal values, including ones sent in the public object by mistake, are absent from `list_public_jobs` |
| 7 | Duplicate applications are handled safely | Test written (`tests/integration/jobs.test.ts`), including three simultaneous submissions |
| 8 | Closed jobs reject applications | Test written: draft, on hold, filled and closed jobs all refuse, from the website and from recruiters |
| 9 | Document access controls | Phase 4 |
| 10 | Notification retries don't produce duplicate sends | Test written (`tests/integration/outbox.test.ts`) |
| 11–14 | Housing | Phase 5 |

The "Test results" section below records whether each test has actually run and passed.

## Open decisions for the owner

- **Single agency or multi-agency.** This is still undecided. The schema separates organizations either way, and nothing assumes billing or self-signup.
- **Inquiry retention period**, and how a person can ask for deletion.

## Test results

On 2026-10-29, after the Zoho and outbox-schedule work (commit `0fa9093`), against the **local** stack:

- **`npm test`: 109 passed, 0 failed**, including 6 Zoho adapter tests (token refusal, unknown send outcome, bad configuration, provider selection, and the outbox refusing to resend a retried Zoho row).
- **`scripts/smoke-functions.sh`: all checks passed**, including `intake` returning `{"ok":true,"reference":"<id>"}`.
- **CI** (GitHub Actions `Test`) passed on the push of `0fa9093`.

Earlier runs, on 2026-10-28, Supabase CLI 2.122.0, Postgres 17, synthetic data only:



- **`npm test`: 103 passed, 0 failed** (2026-10-28, after adding application emails). The run before it failed at file setup: `jobs.test.ts` took more than 60 seconds to create its test users while the load average was about 58. The rerun passed. See the load note below.
  - Application emails:
    - 4 integration tests: both emails are queued with safe payloads; a duplicate, closed job or unknown job queues nothing; the staff alert is skipped when the agency has no alert address; nothing is sent for recruiter-added candidates.
    - 3 unit tests for the templates: wording, the link to the job in ward, escaping, and keeping the subject on one line.
    - The smoke run's outbox worker rendered both templates through the dev adapter, with no failures.
  - 14 unit tests for application validation: normalization, uncollected fields being dropped, the honeypot, and each error message.
  - **Flaky under load.** The machine's load average was 50–150 during these runs, and 3 of the 6 full runs had failures. They were in different files each time (`outbox`, `pipeline` and `intake-and-access`), with the errors `fetch failed` and 30-second timeouts. The outbox file passed on its own, and the other three full runs passed completely, including the last one. One earlier `outbox` failure (3 tests) didn't record its error. These look environmental, but that isn't proven; rerun on an idle machine or in CI before relying on them.
  - 21 unit tests: validation of the live form payload, templates (no contact details, HTML escaping), the Resend adapter (`Idempotency-Key` header, which errors are retried), and the outbox loop.
  - 23 integration tests: items 1, 2, 4 and 6, run as real `anon` and signed-in users.
  - 13 integration tests for the phase 2 pipeline: stage changes with version conflicts (including two simultaneous saves where exactly one wins), closing reasons, assignment limited to same-agency staff, append-only notes, other agencies seeing "not found", anonymous users refused, and direct table writes still blocked.
  - 18 integration tests for phase 3:
    - Job entry: validation messages, a version check on edits, and history that lists which fields changed, never their values.
    - Public listing: only open jobs and only public columns, with no internal values even when they're sent in the public object by mistake.
    - Access: anonymous users and other agencies are kept out of the tables.
    - Status: a published job can't go back to draft.
    - Website applications: duplicates (including simultaneous ones), closed jobs, the wrong agency, consent, server-only access, and rate limiting.
    - Recruiter applications: candidates come from clinician inquiries only. Stage changes need a version, and Rejected and Withdrawn need a reason.
  - 7 integration tests: item 10, covering concurrent claims, backoff, lease expiry, max attempts, and exactly-once sends across worker runs.
- **`scripts/smoke-functions.sh`**, run on 2026-10-28 after adding `apply`: **27 of 27 checks passed**. That includes the 10 intake checks, which also cover the refactor to the shared HTTP helpers.
  - `apply`: preflight; `201` on an open job; `200` for a repeat with different capitalization, still saving one row; `409` for a closed job; `404` for an unknown job; `400` for a malformed id or missing consent; the honeypot (nothing saved); `403` for a foreign origin; `415`; `405`. The `apply` log lines held only request ids and outcomes.
- Earlier smoke run, before `apply`: 12 of 13 checks passed on the first run.
  - Passed: CORS preflight, `201` on submit, `200` for a retry with the same key, `403` for a foreign origin, `400` with the form's error message, `405`, `401` without the outbox secret, and the outbox sending 2 queued notifications through the dev adapter.
  - Honeypot: the first run reported a failure caused by shell quoting in the script. Sent directly, the honeypot returned `200 {"ok":true}`, and the database confirmed no row was saved. The script is fixed; its rerun timed out because the machine was overloaded (below).
  - Function logs contained request ids and outcomes only, and recipients were redacted to `***@example.com`.
- **Not run:**
  - `supabase db lint`: it couldn't connect while the host was overloaded (load average around 86).
  - The hosted project's security advisors: since run (2026-10-28) with no errors; see Integrations.
  - `deno check` on the two function entry points: Deno isn't installed. They did compile and run in the local edge runtime.
