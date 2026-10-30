// Recruiting-only partner model: partner agencies and their terms, partner
// openings and the job board's advertising rule, candidate consent through a
// single-use link, and submissions with attribution.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { addMember, anon, createOrganization, createUser, runId, service } from "./setup.ts";

type User = { id: string; client: SupabaseClient };

let org: { id: string; slug: string };
let otherOrg: { id: string; slug: string };
let admin: User;
let recruiter: User;
let outsider: User;

beforeAll(async () => {
  org = await createOrganization("partners");
  otherOrg = await createOrganization("partners-other");
  [admin, recruiter, outsider] = await Promise.all([
    createUser("partners-admin"), createUser("partners-recruiter"), createUser("partners-outsider"),
  ]);
  await addMember(org.id, admin.id, "admin");
  await addMember(org.id, recruiter.id, "recruiter");
  await addMember(otherOrg.id, outsider.id, "admin");
});

let partnerCount = 0;
const activePartner = (overrides: Record<string, unknown> = {}) => ({
  name: `Synthetic Partner ${runId}-${++partnerCount}`,
  status: "active",
  agreement_signed_on: "2026-10-01",
  attribution_days: 180,
  fee_terms: "SYNTHETIC-FEE-TERMS",
  ...overrides,
});

async function createPartner(overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin.client.rpc("create_partner", { p_organization_id: org.id, p_partner: activePartner(overrides) });
  if (error) throw error;
  return data as { id: string; version: number };
}

const job = {
  title: "Travel RN, ICU", specialty: "ICU", employment_type: "travel", city: "Austin", state: "TX",
  shift: "night", hours_per_week: 36, start_date: "2026-12-07", duration_weeks: 13, openings: 1,
  public_description: "Synthetic partner opening.",
};
const internal = { facility_name: "Synthetic Medical Center", source: "other" };

async function openJob(): Promise<{ id: string; version: number }> {
  const created = await recruiter.client.rpc("create_job", { p_organization_id: org.id, p_job: job, p_internal: internal });
  if (created.error) throw created.error;
  const opened = await recruiter.client.rpc("set_job_status", { p_job_id: created.data.id, p_expected_version: created.data.version, p_status: "open" });
  if (opened.error) throw opened.error;
  return { id: created.data.id, version: opened.data.version };
}

async function setTerms(jobId: string, version: number, terms: Record<string, unknown>, client = recruiter.client) {
  return client.rpc("set_job_terms", { p_job_id: jobId, p_expected_version: version, p_terms: terms });
}

let applicant = 0;
async function apply(jobId: string, email = `partner-applicant-${runId}-${++applicant}@example.com`) {
  const { data, error } = await service.rpc("submit_job_application", {
    p_organization_slug: org.slug, p_job_id: jobId,
    p_application: { full_name: "Test Candidate", email, phone: null, consent_version: "test" },
    p_client_hash: null,
  });
  if (error) throw error;
  return data as { status: string; application_id?: string };
}

// A partner opening with one application, ready for consent.
async function partnerOpening(terms: Record<string, unknown> = {}, partnerOverrides: Record<string, unknown> = {}) {
  const partner = await createPartner(partnerOverrides);
  const opened = await openJob();
  const set = await setTerms(opened.id, opened.version, { partner_id: partner.id, ...terms });
  if (set.error) throw set.error;
  const { data } = await service.from("job_applications").insert({
    job_id: opened.id, organization_id: org.id, source: "recruiter",
    full_name: "Test Candidate", email: `partner-candidate-${runId}-${++applicant}@example.com`,
  }).select("id, email").single();
  return { partner, jobId: opened.id, applicationId: data!.id as string, email: data!.email as string };
}

// The token exists only in the queued email.
async function consentToken(consentId: string): Promise<string> {
  const { data } = await service.from("notification_outbox").select("template_data").eq("dedupe_key", `consent:${consentId}`).single();
  return (data!.template_data as { token: string }).token;
}

async function requestAndGrant(applicationId: string) {
  const req = await recruiter.client.rpc("request_submission_consent", { p_application_id: applicationId });
  if (req.error) throw req.error;
  const token = await consentToken(req.data.consent_id);
  const res = await service.rpc("respond_submission_consent", { p_token: token, p_decision: "granted", p_client_hash: null });
  if (res.error) throw res.error;
  return { consentId: req.data.consent_id as string, token };
}

describe("partners", () => {
  it("are created and changed by admins only, with the agreed terms validated", async () => {
    const created = await createPartner();
    expect(created.version).toBe(1);

    const byRecruiter = await recruiter.client.rpc("create_partner", { p_organization_id: org.id, p_partner: activePartner() });
    expect(byRecruiter.error?.code).toBe("PT403");
    const byOutsider = await outsider.client.rpc("create_partner", { p_organization_id: org.id, p_partner: activePartner() });
    expect(byOutsider.error?.code).toBe("PT403");

    const noDate = await admin.client.rpc("create_partner", { p_organization_id: org.id, p_partner: activePartner({ agreement_signed_on: null }) });
    expect(noDate.error).toMatchObject({ code: "PT400", message: expect.stringMatching(/agreement date/) });
    const adNoTerms = await admin.client.rpc("create_partner", { p_organization_id: org.id, p_partner: activePartner({ may_advertise: true }) });
    expect(adNoTerms.error).toMatchObject({ code: "PT400", message: expect.stringMatching(/advertising permission/) });

    const { data: row } = await admin.client.from("partners").select("name").eq("id", created.id).single();
    const dup = await admin.client.rpc("create_partner", { p_organization_id: org.id, p_partner: activePartner({ name: row!.name.toUpperCase() }) });
    expect(dup.error).toMatchObject({ code: "PT400", message: "A partner with that name already exists" });

    const update = (version: number, client = admin.client) =>
      client.rpc("update_partner", { p_partner_id: created.id, p_expected_version: version, p_partner: activePartner({ name: row!.name, status: "paused" }) });
    expect((await update(1, recruiter.client)).error?.code).toBe("PT403");
    expect((await update(1, outsider.client)).error?.code).toBe("PT404");
    expect((await update(1)).data).toEqual({ id: created.id, version: 2 });
    expect((await update(1)).error?.code).toBe("PT409");
  });

  it("are readable by the agency's staff only", async () => {
    await createPartner();
    expect((await recruiter.client.from("partners").select("id")).data!.length).toBeGreaterThan(0);
    expect((await outsider.client.from("partners").select("id").eq("organization_id", org.id)).data).toEqual([]);
    expect((await anon().from("partners").select("id")).error).not.toBeNull();
  });
});

describe("partner openings", () => {
  it("keep pay, incentives and strike details internal, and bump the job version", async () => {
    const partner = await createPartner();
    const opened = await openJob();
    const { data, error } = await setTerms(opened.id, opened.version, {
      partner_id: partner.id, priority: "critical", is_strike: true, strike_starts_on: "2026-12-01",
      strike_union: "Synthetic Nurses Union", weekly_gross_cents: 310000, housing_stipend_weekly_cents: 120000,
      is_crisis_rate: true, nest_incentive_cents: 50000, ignored_field: "x",
    });
    expect(error).toBeNull();
    expect(data.version).toBe(opened.version + 1);
    expect((await setTerms(opened.id, opened.version, { priority: "high" })).error?.code).toBe("PT409");

    const { data: terms } = await recruiter.client.from("job_partner_terms").select("*").eq("job_id", opened.id).single();
    expect(terms).toMatchObject({ partner_id: partner.id, priority: "critical", is_strike: true, weekly_gross_cents: 310000, nest_incentive_cents: 50000 });
    const { data: events } = await service.from("job_events").select("details").eq("job_id", opened.id).eq("event_type", "terms_updated");
    expect(JSON.stringify(events)).not.toContain("310000");
  });

  it("validate the partner and strike fields", async () => {
    const opened = await openJob();
    const { data: foreign } = await service.from("partners").insert({ organization_id: otherOrg.id, name: `Foreign ${runId}` }).select("id").single();
    expect((await setTerms(opened.id, opened.version, { partner_id: foreign!.id })).error)
      .toMatchObject({ code: "PT400", message: "Choose a partner from this agency" });
    expect((await setTerms(opened.id, opened.version, { strike_union: "Union" })).error)
      .toMatchObject({ code: "PT400", message: expect.stringMatching(/only apply to strike/) });
    expect((await setTerms(opened.id, opened.version, { is_strike: true, strike_starts_on: "2026-12-10", strike_ends_on: "2026-12-01" })).error)
      .toMatchObject({ code: "PT400" });
    expect((await setTerms(opened.id, opened.version, { weekly_gross_cents: -1 })).error?.code).toBe("PT400");
    expect((await setTerms(opened.id, opened.version, { priority: "normal" })).error)
      .toMatchObject({ code: "PT400", message: "Nothing changed" });
    expect((await setTerms(opened.id, opened.version, { priority: "high" }, outsider.client)).error?.code).toBe("PT404");
  });

  it("reach the job board only with an active partner's advertising permission, strike-labelled", async () => {
    const listed = async () => {
      const { data } = await anon().rpc("list_public_jobs", { p_organization_slug: org.slug });
      return new Map((data as { id: string; is_strike: boolean }[]).map((j) => [j.id, j]));
    };
    const direct = await openJob();
    const noAds = await partnerOpening();
    const ads = await partnerOpening({ is_strike: true }, { may_advertise: true, advertising_terms: "Written permission, synthetic" });
    const pausedAds = await partnerOpening({}, { status: "paused", may_advertise: true, advertising_terms: "Synthetic" });

    const board = await listed();
    expect(board.get(direct.id)?.is_strike).toBe(false);
    expect(board.has(noAds.jobId)).toBe(false);
    expect(board.has(pausedAds.jobId)).toBe(false);
    expect(board.get(ads.jobId)?.is_strike).toBe(true);
    expect(Object.keys(board.get(ads.jobId)!)).not.toContain("weekly_gross_cents");

    expect(await apply(noAds.jobId)).toEqual({ status: "job_not_found" });
    expect(await apply(ads.jobId)).toMatchObject({ status: "created" });
  });
});

describe("submission consent", () => {
  it("is requested by staff and emailed with a token stored only as a hash", async () => {
    const o = await partnerOpening();
    const { data, error } = await recruiter.client.rpc("request_submission_consent", { p_application_id: o.applicationId });
    expect(error).toBeNull();
    expect(data).toMatchObject({ includes_strike: false });

    const token = await consentToken(data.consent_id);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const { data: email } = await service.from("notification_outbox").select("template, recipient, template_data")
      .eq("dedupe_key", `consent:${data.consent_id}`).single();
    expect(email).toMatchObject({ template: "submission_consent_request", recipient: o.email });

    const { data: row } = await recruiter.client.from("submission_consents").select("status, consent_text, consent_version").eq("id", data.consent_id).single();
    expect(row).toMatchObject({ status: "pending", consent_version: "submission-v1" });
    expect(row!.consent_text).toMatch(/would be my employer/);
    expect((await recruiter.client.from("submission_consents").select("token_hash")).error).not.toBeNull();
    const { data: stored } = await service.from("submission_consents").select("token_hash").eq("id", data.consent_id).single();
    expect(stored!.token_hash).not.toBe(token);
  });

  it("needs an active partner on the opening, and a new request replaces the pending one", async () => {
    const opened = await openJob();
    const { data: app } = await service.from("job_applications").insert({
      job_id: opened.id, organization_id: org.id, source: "recruiter", full_name: "No Partner", email: `no-partner-${runId}@example.com`,
    }).select("id").single();
    expect((await recruiter.client.rpc("request_submission_consent", { p_application_id: app!.id })).error)
      .toMatchObject({ code: "PT400", message: expect.stringMatching(/Link this opening to a partner/) });
    const paused = await partnerOpening({}, { status: "paused" });
    expect((await recruiter.client.rpc("request_submission_consent", { p_application_id: paused.applicationId })).error)
      .toMatchObject({ code: "PT400" });

    const o = await partnerOpening();
    const first = await recruiter.client.rpc("request_submission_consent", { p_application_id: o.applicationId });
    const second = await recruiter.client.rpc("request_submission_consent", { p_application_id: o.applicationId });
    expect(second.error).toBeNull();
    const { data: rows } = await service.from("submission_consents").select("id, status").eq("application_id", o.applicationId);
    expect(rows!.find((r) => r.id === first.data.consent_id)?.status).toBe("revoked");
    const { data: firstEmail } = await service.from("notification_outbox").select("status, template_data").eq("dedupe_key", `consent:${first.data.consent_id}`).single();
    expect(firstEmail!.status).toBe("cancelled");
    expect(firstEmail!.template_data).not.toHaveProperty("token");
    expect((await outsider.client.rpc("request_submission_consent", { p_application_id: o.applicationId })).error?.code).toBe("PT404");
  });

  it("is answered once through the link, by the server only", async () => {
    const o = await partnerOpening();
    const req = await recruiter.client.rpc("request_submission_consent", { p_application_id: o.applicationId });
    const token = await consentToken(req.data.consent_id);

    const view = await service.rpc("view_submission_consent", { p_token: token });
    expect(view.data).toMatchObject({ status: "pending", job_title: "Travel RN, ICU", city: "Austin", includes_strike: false });
    expect(JSON.stringify(view.data)).not.toContain(o.email);
    expect((await service.rpc("view_submission_consent", { p_token: "0".repeat(64) })).data).toEqual({ status: "not_found" });
    expect((await service.rpc("view_submission_consent", { p_token: "not-a-token" })).data).toEqual({ status: "not_found" });

    expect((await anon().rpc("respond_submission_consent", { p_token: token, p_decision: "granted", p_client_hash: null })).error).not.toBeNull();
    expect((await recruiter.client.rpc("respond_submission_consent", { p_token: token, p_decision: "granted", p_client_hash: null })).error).not.toBeNull();

    const yes = await service.rpc("respond_submission_consent", { p_token: token, p_decision: "granted", p_client_hash: "hash" });
    expect(yes.data).toEqual({ status: "granted", already_answered: false });
    const again = await service.rpc("respond_submission_consent", { p_token: token, p_decision: "declined", p_client_hash: null });
    expect(again.data).toEqual({ status: "granted", already_answered: true });
    const { data: row } = await service.from("submission_consents").select("status, response_method, responded_at").eq("id", req.data.consent_id).single();
    expect(row).toMatchObject({ status: "granted", response_method: "email_link" });
  });

  it("expires after its deadline", async () => {
    const o = await partnerOpening();
    const req = await recruiter.client.rpc("request_submission_consent", { p_application_id: o.applicationId });
    const token = await consentToken(req.data.consent_id);
    await service.from("submission_consents").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", req.data.consent_id);
    expect((await service.rpc("respond_submission_consent", { p_token: token, p_decision: "granted", p_client_hash: null })).data)
      .toEqual({ status: "expired", already_answered: true });
  });

  it("names the strike for a strike assignment, and the token is removed once the email is sent", async () => {
    const o = await partnerOpening({ is_strike: true, strike_starts_on: "2026-12-01", strike_ends_on: "2026-12-05" });
    const req = await recruiter.client.rpc("request_submission_consent", { p_application_id: o.applicationId });
    expect(req.data.includes_strike).toBe(true);
    const { data: row } = await service.from("submission_consents").select("consent_text, consent_version").eq("id", req.data.consent_id).single();
    expect(row!.consent_version).toBe("submission-strike-v1");
    expect(row!.consent_text).toMatch(/strike assignment.*December 1, 2026 to December 5, 2026.*picket line/s);

    await service.from("notification_outbox").update({ status: "sent" }).eq("dedupe_key", `consent:${req.data.consent_id}`);
    const { data: email } = await service.from("notification_outbox").select("template_data").eq("dedupe_key", `consent:${req.data.consent_id}`).single();
    expect(email!.template_data).not.toHaveProperty("token");
    expect(email!.template_data).toMatchObject({ is_strike: true });
  });
});

describe("submitting to a partner", () => {
  const submit = (applicationId: string, client = recruiter.client, ref: string | null = null) =>
    client.rpc("submit_to_partner", { p_application_id: applicationId, p_partner_candidate_reference: ref });

  it("needs the candidate's approval, then records attribution and moves the application to submitted", async () => {
    const o = await partnerOpening();
    expect((await submit(o.applicationId)).error)
      .toMatchObject({ code: "PT400", message: "The candidate hasn't approved this submission yet" });
    await requestAndGrant(o.applicationId);

    const { data, error } = await submit(o.applicationId, recruiter.client, " CAND-1 ");
    expect(error).toBeNull();
    const expected = new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10);
    expect(data).toMatchObject({ prior_live_submissions: 0 });
    expect([expected, new Date(Date.now() + 179 * 86400000).toISOString().slice(0, 10)]).toContain(data.attribution_expires_on);

    const { data: app } = await service.from("job_applications").select("stage").eq("id", o.applicationId).single();
    expect(app!.stage).toBe("submitted");
    const { data: sub } = await recruiter.client.from("partner_submissions").select("status, partner_candidate_reference, candidate_email").eq("id", data.id).single();
    expect(sub).toEqual({ status: "submitted", partner_candidate_reference: "CAND-1", candidate_email: o.email });

    expect((await submit(o.applicationId)).error)
      .toMatchObject({ code: "PT400", message: expect.stringMatching(/already been submitted/) });
    expect((await submit(o.applicationId, outsider.client)).error?.code).toBe("PT404");
    expect((await recruiter.client.rpc("request_submission_consent", { p_application_id: o.applicationId })).error?.code).toBe("PT400");
  });

  it("needs the partner's attribution period", async () => {
    const o = await partnerOpening({}, { attribution_days: null });
    await requestAndGrant(o.applicationId);
    expect((await submit(o.applicationId)).error)
      .toMatchObject({ code: "PT400", message: expect.stringMatching(/attribution period/) });
  });

  it("refuses a strike assignment approved before it was marked as one", async () => {
    const o = await partnerOpening();
    await requestAndGrant(o.applicationId);
    const { data: j } = await service.from("jobs").select("version").eq("id", o.jobId).single();
    expect((await setTerms(o.jobId, j!.version, { partner_id: o.partner.id, is_strike: true })).error).toBeNull();
    expect((await submit(o.applicationId)).error)
      .toMatchObject({ code: "PT400", message: expect.stringMatching(/strike assignment/) });
  });

  it("counts earlier live submissions of the same person to the same partner", async () => {
    const o = await partnerOpening();
    await requestAndGrant(o.applicationId);
    expect((await submit(o.applicationId)).error).toBeNull();

    const second = await openJob();
    await setTerms(second.id, second.version, { partner_id: o.partner.id });
    const { data: app } = await service.from("job_applications").insert({
      job_id: second.id, organization_id: org.id, source: "recruiter", full_name: "Test Candidate", email: o.email,
    }).select("id").single();
    await requestAndGrant(app!.id);
    expect((await submit(app!.id)).data).toMatchObject({ prior_live_submissions: 1 });
  });

  it("can be withdrawn or marked a partner duplicate, with a reason", async () => {
    const o = await partnerOpening();
    await requestAndGrant(o.applicationId);
    const { data } = await submit(o.applicationId);
    const change = (version: number, status: string, reason: string | null) =>
      recruiter.client.rpc("update_partner_submission", { p_submission_id: data.id, p_expected_version: version, p_status: status, p_reason: reason });

    expect((await change(1, "withdrawn", " ")).error).toMatchObject({ code: "PT400", message: "Give a reason" });
    expect((await change(1, "partner_duplicate", "Partner already had them")).data).toMatchObject({ status: "partner_duplicate", version: 2 });
    expect((await change(1, "withdrawn", "x")).error?.code).toBe("PT409");
    expect((await change(2, "withdrawn", "x")).error?.code).toBe("PT400");
  });
});
