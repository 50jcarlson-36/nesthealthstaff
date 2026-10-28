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
| Subdomains `staff.`, `employers.`, `morgue.` | **Unverified** | Planned hosts, now used in email links, CORS and auth docs | Create DNS records and hosting once the portals exist | No portal frontends yet, and DNS isn't active |
| SMS: Twilio | **Deferred** | n/a | The outbox `channel` column can take SMS later | n/a |
| Billing: Stripe | **Deferred** | n/a | n/a | Business-model decision |
| Housing: Extended Stay, Marriott, Hilton | **Unverified** | Not researched yet. No relationships exist. | Research official partner and affiliate routes (phase 5) | n/a |
| License verification, background checks, e-signature, payroll | **Deferred** | n/a | n/a | Providers not chosen |

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
- **Where the portal frontends are hosted:** `staff.`, `employers.` and `morgue.`.

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
