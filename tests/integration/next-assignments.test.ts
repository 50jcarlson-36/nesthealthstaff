// Next-assignment planning: endings, plans, options and putting a clinician
// forward, plus the journey overview's next action once a plan is settled.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { addMember, createOrganization, createUser, runId, service } from "./setup.ts";

type User = { id: string; client: SupabaseClient };

let org: { id: string };
let recruiter: User;
let outsider: User;
let partnerId: string;
let count = 0;

const daysFromNow = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  org = await createOrganization("next");
  const other = await createOrganization("next-other");
  [recruiter, outsider] = await Promise.all([createUser("next-recruiter"), createUser("next-outsider")]);
  await addMember(org.id, recruiter.id, "admin");
  await addMember(other.id, outsider.id, "admin");
  const { data } = await recruiter.client.rpc("create_partner", {
    p_organization_id: org.id,
    p_partner: { name: `Next Partner ${runId}`, status: "active", agreement_signed_on: "2026-10-01", attribution_days: 90 },
  });
  partnerId = data.id;
});

async function openJob(job: Record<string, unknown>, terms: Record<string, unknown>) {
  const created = await recruiter.client.rpc("create_job", {
    p_organization_id: org.id,
    p_job: { title: "Travel RN", specialty: "ICU", employment_type: "travel", city: "Austin", state: "TX", openings: 1, duration_weeks: 13, ...job },
    p_internal: { facility_name: "Synthetic Hospital" },
  });
  if (created.error) throw created.error;
  const opened = await recruiter.client.rpc("set_job_status", { p_job_id: created.data.id, p_expected_version: created.data.version, p_status: "open" });
  await recruiter.client.rpc("set_job_terms", { p_job_id: created.data.id, p_expected_version: opened.data.version, p_terms: { partner_id: partnerId, ...terms } });
  return created.data.id as string;
}

// A clinician on assignment on a fresh job, ending in `endsIn` days.
async function onAssignment(endsIn: number, terms: Record<string, unknown> = { weekly_gross_cents: 250000, extension_bonus_cents: 100000 }) {
  const jobId = await openJob({ start_date: daysFromNow(endsIn - 91) }, terms);
  const { data: app } = await service.from("job_applications").insert({
    job_id: jobId, organization_id: org.id, source: "recruiter", full_name: "Next Candidate",
    email: `next-${runId}-${++count}@example.com`, phone: "555-0101",
  }).select("id").single();
  const req = await recruiter.client.rpc("request_submission_consent", { p_application_id: app!.id });
  const { data: email } = await service.from("notification_outbox").select("template_data").eq("dedupe_key", `consent:${req.data.consent_id}`).single();
  await service.rpc("respond_submission_consent", { p_token: (email!.template_data as { token: string }).token, p_decision: "granted", p_client_hash: null });
  const sub = await recruiter.client.rpc("submit_to_partner", { p_application_id: app!.id, p_partner_candidate_reference: null });
  const started = await recruiter.client.rpc("update_journey_stage", {
    p_submission_id: sub.data.id, p_expected_version: 1, p_stage: "started", p_note: null,
    p_start_on: daysFromNow(endsIn - 91), p_end_on: daysFromNow(endsIn),
  });
  if (started.error) throw started.error;
  return { applicationId: app!.id as string, jobId };
}

const ending = async (applicationId: string, client = recruiter.client) =>
  (await client.from("assignment_endings").select("*").eq("application_id", applicationId)).data?.[0];
const overview = async (applicationId: string) =>
  (await recruiter.client.from("journey_overview").select("next_action, next_action_due, plan_status").eq("application_id", applicationId)).data?.[0];

describe("assignment endings", () => {
  it("list clinicians ending soon with current pay, the extension bonus and the plan", async () => {
    const soon = await onAssignment(30);
    const later = await onAssignment(200);
    expect(await ending(soon.applicationId)).toMatchObject({
      days_left: 30, assignment_end_on: daysFromNow(30), current_weekly_cents: 250000, extension_bonus_cents: 100000,
      plan_status: "not_started", plan_version: null, stage: "started",
    });
    expect(await ending(later.applicationId)).toBeUndefined();
    expect(await ending(soon.applicationId, outsider.client)).toBeUndefined();
  });
});

describe("plans", () => {
  it("are versioned, logged, and settle the journey's next action", async () => {
    const { applicationId } = await onAssignment(30);
    expect(await overview(applicationId)).toMatchObject({ next_action: "Plan the next assignment", next_action_due: daysFromNow(2), plan_status: null });

    const set = (version: number | null, status: string, note: string | null = null, client = recruiter.client) =>
      client.rpc("set_next_assignment_plan", { p_application_id: applicationId, p_expected_version: version, p_status: status, p_note: note });
    expect((await set(null, "extension_offered", "Offered 13 more weeks")).data).toMatchObject({ status: "extension_offered", version: 1 });
    expect((await set(null, "looking")).error?.code).toBe("PT409");
    expect((await set(1, "extension_offered", "Offered 13 more weeks")).error).toMatchObject({ code: "PT400", message: "Nothing changed" });
    expect((await set(1, "extending", null, outsider.client)).error?.code).toBe("PT404");
    expect(await overview(applicationId)).toMatchObject({ next_action: "Plan the next assignment", plan_status: "extension_offered" });

    expect((await set(1, "extending")).data).toMatchObject({ version: 2 });
    expect(await overview(applicationId)).toMatchObject({ next_action: "Check in during the assignment", plan_status: "extending" });
    expect(await ending(applicationId)).toMatchObject({ plan_status: "extending", plan_version: 2, plan_note: null });

    const { data: events } = await service.from("application_events").select("details").eq("application_id", applicationId).eq("event_type", "next_assignment_plan").order("id");
    expect(events!.map((e) => (e.details as { status: string }).status)).toEqual(["extension_offered", "extending"]);
  });
});

describe("options", () => {
  it("rank other open jobs by fit and opportunity, with the pay change against now", async () => {
    const current = await onAssignment(30, { weekly_gross_cents: 250000 });
    const follows = await openJob({ title: "Follows on", start_date: daysFromNow(35) }, { weekly_gross_cents: 275000 });
    const overlaps = await openJob({ title: "Overlaps", start_date: daysFromNow(10) }, { weekly_gross_cents: 300000 });
    const elsewhere = await openJob({ title: "Other specialty", specialty: "Telemetry", state: "CO", city: "Denver", start_date: daysFromNow(35) }, { weekly_gross_cents: 250000, is_strike: true });

    const { data, error } = await recruiter.client.rpc("next_assignment_options", { p_application_id: current.applicationId });
    expect(error).toBeNull();
    const byId = new Map((data as { job_id: string }[]).map((o) => [o.job_id, o]));
    expect(byId.has(current.jobId)).toBe(false);
    expect(byId.get(follows)).toMatchObject({ fit_score: 100, pay_change_pct: 10, fit_reasons: ["Same specialty", "Same state", "Starts as the current one ends"] });
    expect(byId.get(overlaps)).toMatchObject({ fit_score: 75, pay_change_pct: 20, fit_reasons: ["Same specialty", "Same state", "Starts before the current one ends"] });
    expect(byId.get(elsewhere)).toMatchObject({ fit_score: 40, is_strike: true, pay_change_pct: 0 });
    for (const o of data as { fit_score: number; opportunity_score: number; rank: number }[]) {
      expect(o.rank).toBe(Math.round(0.6 * o.fit_score + 0.4 * o.opportunity_score));
    }
    expect((await outsider.client.rpc("next_assignment_options", { p_application_id: current.applicationId })).data).toEqual([]);
  });

  it("put the clinician forward with their contact details and link the plan", async () => {
    const current = await onAssignment(25);
    const next = await openJob({ title: "Next one", start_date: daysFromNow(30) }, { weekly_gross_cents: 260000 });
    const put = (job: string, client = recruiter.client) => client.rpc("put_forward_for_next_assignment", { p_application_id: current.applicationId, p_job_id: job });

    expect((await put(current.jobId)).error).toMatchObject({ code: "PT400", message: expect.stringMatching(/Record an extension/) });
    expect((await put(next, outsider.client)).error?.code).toBe("PT404");
    const { data, error } = await put(next);
    expect(error).toBeNull();
    const { data: app } = await service.from("job_applications").select("job_id, full_name, email, phone, source, stage").eq("id", data.id).single();
    const { data: was } = await service.from("job_applications").select("email").eq("id", current.applicationId).single();
    expect(app).toEqual({ job_id: next, full_name: "Next Candidate", email: was!.email, phone: "555-0101", source: "recruiter", stage: "applied" });
    expect(await ending(current.applicationId)).toMatchObject({ plan_status: "looking", next_job_id: next, plan_version: 1 });
    expect((await put(next)).error).toMatchObject({ code: "PT400", message: "This clinician is already on that job" });

    // A settled plan stays settled when they're put forward again.
    await recruiter.client.rpc("set_next_assignment_plan", { p_application_id: current.applicationId, p_expected_version: 1, p_status: "next_lined_up", p_note: null });
    const another = await openJob({ title: "Backup", start_date: daysFromNow(30) }, {});
    await put(another);
    expect(await ending(current.applicationId)).toMatchObject({ plan_status: "next_lined_up", next_job_id: another, plan_version: 3 });
  });
});
