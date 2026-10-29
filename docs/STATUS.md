# Status report

Last updated 2026-10-28. All data in this repo and its tests is synthetic, using `@example.com` addresses. No production data has been created, read or changed.

## Delivery phases

| Phase | State |
|---|---|
| 1. Intake: submit → inquiry saved → notifications queued | **Built and tested locally.** Not deployed. The frontend isn't connected yet. |
| 2. Staff: sign in → review → update pipeline | **Built and tested locally.** Database functions `change_inquiry_stage`, `assign_inquiry`, `add_inquiry_note` and `organization_staff` handle stage changes (a reason is required to close), recruiter assignment (same-agency staff only) and append-only notes. Stage and assignment changes use optimistic concurrency via `version`. `ward.` exposes all of it, and was checked in a browser against the local stack only. Not deployed. |
| 3. Recruiting: jobs, applications | **Built and tested locally.** Recruiters enter jobs by hand in `ward.`. Each job is stored in two parts: public fields in `jobs`, and facility, requisition, rates and notes in `job_internal_details`, which only staff can read. The public listing reads only open jobs, through `list_public_jobs`, and only their public columns. Applications go in `job_applications`, from the website via the service-role function `submit_job_application`, or from a recruiter putting forward a clinician inquiry. Pay is internal only until the supplier agreements say otherwise. The public `apply` Edge Function validates applications and calls `submit_job_application`. New website applications queue an applicant confirmation and a staff alert through the outbox. **Not built yet:** the job board and apply form on the website. Checked in a browser against the local stack only. Not deployed. |
| 4. Onboarding: profiles, private documents | Not started |
| 5. Placement: assignments, housing | Not started |

## Integrations

| Connection | Status | Evidence / source | Next action | Blocker |
|---|---|---|---|---|
| Supabase database (hosted `fugzapgjowwwqgymcdbl`) | **Access required** | The API responded on 2026-10-27. A read-only MCP config is committed. | Authenticate the MCP, inspect the existing schema, then get approval to push migrations | The owner must authenticate. The hosted schema hasn't been inspected. |
| Supabase local stack | See the test results below | `supabase start` on ports 553xx | n/a | n/a |
| Supabase Auth | **Available, not connected** | Configured locally only | Set the production Site URL and redirect URLs (DEPLOYMENT.md) | Hosted access |
| Supabase Storage (private documents) | **Deferred** to phase 4 | n/a | n/a | n/a |
| Live website `/api/leads` | **Unverified** | The endpoint exists and returns 405 to GET. Where it stores leads is unknown. | Get the Sites source and point the form at `/functions/v1/intake` | The Sites export to GitHub failed twice. |
| Email inboxes: Zoho Mail | **Partly set up; delivery not tested** | Checked 2026-10-28. In the Zoho organization `mowmatter` (Mail Lite plan, 1 licence), `nesthealthstaff.com` shows "Verified". Public DNS has the Zoho MX records, SPF `include:zohomail.com`, and DKIM selector `zmail`. These aliases were added to the one mailbox, `jcarlson@mowmatter.com`: `recruiting@`, `hello@`, `privacy@` and `dmarc@`. Zoho refused `postmaster@` and `abuse@` as user aliases (`NOT_ALLOWED_AS_USER_ALIAS`). No test email has been sent to any alias. | Send a test message to each alias. Decide how to cover `postmaster@` and `abuse@`, for example with a Zoho group. Add a DMARC TXT record in Cloudflare: `_dmarc` with `v=DMARC1; p=none; rua=mailto:dmarc@nesthealthstaff.com`. Set the production organization's `intake_notification_email` to `recruiting@`. | DMARC needs Cloudflare access. The alert address needs hosted database access. |
| Email: Resend | **Available, not connected** | [Resend send-email API](https://resend.com/docs/api-reference/emails/send-email), checked 2026-10-28. It supports `Idempotency-Key` (24h retention). | Create an account, verify the sender domain in Cloudflare, set secrets | No account, key or verified domain. Notifications currently use the **dev adapter**, which logs and doesn't deliver. |
| Domain `nesthealthstaff.com` | **Verified working** | Checked 2026-10-28: Cloudflare is the registrar and nameservers (`kellen`/`raphaela.ns.cloudflare.com`). The apex and `www` (CNAME `custom-domains.chatgpt.site`) both return `200` over valid HTTPS and serve the Sites frontend; `/api/leads` returns `405` to GET. | Optionally redirect `www` to the apex, so there's one canonical host | n/a |
| Subdomains `staff.`, `employers.`, `ward.` | **Not live** | Checked 2026-10-28: none of the three has a DNS record. Hosting is decided: Cloudflare Workers. `ward.` is scaffolded with a custom-domain route that creates its DNS record on deploy. | Deploy `ward` (DEPLOYMENT.md), then build `staff.` and `employers.` the same way | Cloudflare access to deploy, and the hosted Supabase setup |
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
| **Direct facility contracts** | Job orders straight from a hospital, which a recruiter enters in `ward.` | **Available, not connected.** Job entry is built (phase 3), locally only; no real facility contract exists yet. | A signed staffing agreement with each facility | Build phase 3 job entry. This is the first-release path. |
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
- **Which address receives staff alerts:** the `intake_notification_email` on the production organization.

## Test results

Run on 2026-10-28 against the **local** stack: Supabase CLI 2.122.0, Postgres 17, synthetic data only.

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
  - The hosted project's security advisors: no access yet.
  - `deno check` on the two function entry points: Deno isn't installed. They did compile and run in the local edge runtime.
