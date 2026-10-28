# Status report

Last updated 2026-10-28. All data in this repo and its tests is synthetic, using `@example.com` addresses. No production data has been created, read or changed.

## Delivery phases

| Phase | State |
|---|---|
| 1. Intake: submit → inquiry saved → notifications queued | **Built and tested locally.** Not deployed. The frontend isn't connected yet. |
| 2. Staff: sign in → review → update pipeline | Not started. Read access and RLS exist; stage changes, notes, assignment and concurrency control are next. |
| 3. Recruiting: jobs, applications | Not started |
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
| Email: Resend | **Available, not connected** | [Resend send-email API](https://resend.com/docs/api-reference/emails/send-email), checked 2026-10-28. It supports `Idempotency-Key` (24h retention). | Create an account, verify the sender domain in Cloudflare, set secrets | No account, key or verified domain. Notifications currently use the **dev adapter**, which logs and doesn't deliver. |
| Domain `nesthealthstaff.com` | **Unverified, not live** | The name didn't resolve in DNS on 2026-10-27 | Finish Cloudflare activation | Cloudflare access |
| Subdomains `staff.`, `employers.`, `ward.` | **Unverified** | Planned hosts, now used in email links, CORS and auth docs | Create DNS records and hosting once the portals exist | No portal frontends yet, and DNS isn't active |
| NurseRecruiter.com: **jobs in** | **Unverified (not offered)** | The [API docs](https://api.nurserecruiter.com/) (checked 2026-10-28) document only `GET /v1/candidates` and `GET /v1/resume/{id}`. There's no jobs endpoint or job feed. The site lets employers *post* jobs there. | Ask NurseRecruiter whether a job feed or partner syndication exists | No documented route |
| NurseRecruiter.com: candidates in | **Access required** | The same docs describe Bearer-token auth, issued "once your integration is enabled". Up to 100 candidates per page, filterable by acquisition date. Rate limits and webhooks aren't documented. | Needs an employer account with the integration enabled. Importing resumes also needs phase 4 private document storage. | No account or token |
| SMS: Twilio | **Deferred** | n/a | The outbox `channel` column can take SMS later | n/a |
| Billing: Stripe | **Deferred** | n/a | n/a | Business-model decision |
| Housing: Extended Stay, Marriott, Hilton | **Unverified** | Not researched yet. No relationships exist. | Research official partner and affiliate routes (phase 5) | n/a |
| License verification, background checks, e-signature, payroll | **Deferred** | n/a | n/a | Providers not chosen |

## Job listing sources (researched 2026-10-28)

How it works: hospitals buy travel and contract nurses through direct agency contracts, or through a **vendor management system (VMS)**, often run by a **managed service provider (MSP)**. Job orders go only to agencies approved as suppliers on that program. We found **no public feed** of travel-nurse job orders that an agency can subscribe to. Every route below starts with a business agreement, not an API key.

Most sources below are vendor pages and trade press, not program documentation. Exact supplier requirements and API terms come from each program once you start the supplier process.

| Source | What it gives us | Status | Access requirements | Next action |
|---|---|---|---|---|
| **Direct facility contracts** | Job orders straight from a hospital, which a recruiter enters in `ward.` | **Available, not connected.** Needs the phase 3 jobs module. | A signed staffing agreement with each facility | Build phase 3 job entry. This is the first-release path. |
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
| 3 | Clinicians can't access other clinicians' documents or applications | Phase 3–4 |
| 4 | Recruiters cannot access another organization's records | Test written |
| 5 | Facility users cannot access unrelated facilities | Phase 3 (facility memberships aren't built yet) |
| 6 | Users cannot promote themselves or change protected fields | Test written |
| 7 | Duplicate applications are handled safely | Phase 3. Duplicate *inquiries* are tested. |
| 8 | Closed jobs reject applications | Phase 3 |
| 9 | Document access controls | Phase 4 |
| 10 | Notification retries don't produce duplicate sends | Test written (`tests/integration/outbox.test.ts`) |
| 11–14 | Housing | Phase 5 |

The "Test results" section below records whether each test has actually run and passed.

## Open decisions for the owner

- **Single agency or multi-agency.** This is still undecided. The schema separates organizations either way, and nothing assumes billing or self-signup.
- **Inquiry retention period**, and how a person can ask for deletion.
- **Which address receives staff alerts:** the `intake_notification_email` on the production organization.
- **Where the portal frontends are hosted:** `staff.`, `employers.` and `ward.`.

## Test results

Run on 2026-10-28 against the **local** stack: Supabase CLI 2.122.0, Postgres 17, synthetic data only.

- **`npm test`: 51 passed, 0 failed.**
  - 21 unit tests: validation of the live form payload, templates (no contact details, HTML escaping), the Resend adapter (`Idempotency-Key` header, which errors are retried), and the outbox loop.
  - 23 integration tests: items 1, 2, 4 and 6, run as real `anon` and signed-in users.
  - 7 integration tests: item 10, covering concurrent claims, backoff, lease expiry, max attempts, and exactly-once sends across worker runs.
- **`scripts/smoke-functions.sh`** ran the Edge Functions over HTTP: 12 of 13 checks passed on the first run.
  - Passed: CORS preflight, `201` on submit, `200` for a retry with the same key, `403` for a foreign origin, `400` with the form's error message, `405`, `401` without the outbox secret, and the outbox sending 2 queued notifications through the dev adapter.
  - Honeypot: the first run reported a failure caused by shell quoting in the script. Sent directly, the honeypot returned `200 {"ok":true}`, and the database confirmed no row was saved. The script is fixed; its rerun timed out because the machine was overloaded (below).
  - Function logs contained request ids and outcomes only, and recipients were redacted to `***@example.com`.
- **Not run:**
  - `supabase db lint`: it couldn't connect while the host was overloaded (load average around 86).
  - The hosted project's security advisors: no access yet.
  - `deno check` on the two function entry points: Deno isn't installed. They did compile and run in the local edge runtime.
