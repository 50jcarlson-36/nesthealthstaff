// Candidate journeys: stages after submission, the checklist with partner
// requirements, and the computed next action and overdue state.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { addMember, createOrganization, createUser, runId, service } from "./setup.ts";

type User = { id: string; client: SupabaseClient };
type Overview = {
  application_id: string;
  next_action: string;
  next_action_due: string;
  overdue: boolean;
  missing_items: number;
  journey_stage: string | null;
  submission_version: number | null;
};

let org: { id: string; slug: string };
let admin: User;
let recruiter: User;
let outsider: User;

beforeAll(async () => {
  org = await createOrganization("journeys");
  const other = await createOrganization("journeys-other");
  [admin, recruiter, outsider] = await Promise.all([
    createUser("journeys-admin"), createUser("journeys-recruiter"), createUser("journeys-outsider"),
  ]);
  await addMember(org.id, admin.id, "admin");
  await addMember(org.id, recruiter.id, "recruiter");
  await addMember(other.id, outsider.id, "admin");
});

const today = () => new Date().toISOString().slice(0, 10);
const daysFromNow = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

let count = 0;
async function partner(requirements: object[] = []) {
  const { data, error } = await admin.client.rpc("create_partner", {
    p_organization_id: org.id,
    p_partner: { name: `Journey Partner ${runId}-${++count}`, status: "active", agreement_signed_on: "2026-10-01", attribution_days: 90 },
  });
  if (error) throw error;
  if (requirements.length) {
    const set = await admin.client.rpc("set_partner_requirements", { p_partner_id: data.id, p_requirements: requirements });
    if (set.error) throw set.error;
  }
  return data.id as string;
}

// An open partner opening starting in 30 days, with one application.
async function application(partnerId: string) {
  const created = await recruiter.client.rpc("create_job", {
    p_organization_id: org.id,
    p_job: { title: "Travel RN, Med-Surg", specialty: "Med-Surg", employment_type: "travel", city: "Tulsa", state: "OK", start_date: daysFromNow(30), openings: 1 },
    p_internal: { facility_name: "Synthetic Hospital" },
  });
  if (created.error) throw created.error;
  const opened = await recruiter.client.rpc("set_job_status", { p_job_id: created.data.id, p_expected_version: created.data.version, p_status: "open" });
  await recruiter.client.rpc("set_job_terms", { p_job_id: created.data.id, p_expected_version: opened.data.version, p_terms: { partner_id: partnerId } });
  const { data } = await service.from("job_applications").insert({
    job_id: created.data.id, organization_id: org.id, source: "recruiter",
    full_name: "Journey Candidate", email: `journey-${runId}-${++count}@example.com`,
  }).select("id").single();
  return data!.id as string;
}

async function overview(applicationId: string, client = recruiter.client): Promise<Overview | undefined> {
  const { data } = await client.from("journey_overview").select("*").eq("application_id", applicationId);
  return (data as Overview[] | null)?.[0];
}

async function grantAndSubmit(applicationId: string) {
  const req = await recruiter.client.rpc("request_submission_consent", { p_application_id: applicationId });
  const { data: email } = await service.from("notification_outbox").select("template_data").eq("dedupe_key", `consent:${req.data.consent_id}`).single();
  await service.rpc("respond_submission_consent", { p_token: (email!.template_data as { token: string }).token, p_decision: "granted", p_client_hash: null });
  const submitted = await recruiter.client.rpc("submit_to_partner", { p_application_id: applicationId, p_partner_candidate_reference: null });
  if (submitted.error) throw submitted.error;
  return submitted.data.id as string;
}

const stage = (id: string, version: number, to: string, note: string | null = null, start: string | null = null, end: string | null = null) =>
  recruiter.client.rpc("update_journey_stage", {
    p_submission_id: id, p_expected_version: version, p_stage: to, p_note: note, p_start_on: start, p_end_on: end,
  });

describe("journey overview before submission", () => {
  it("follows the consent: ask, wait, then record the submission", async () => {
    const app = await application(await partner());
    expect(await overview(app)).toMatchObject({ next_action: "Ask the candidate for approval", next_action_due: today(), overdue: false });

    const req = await recruiter.client.rpc("request_submission_consent", { p_application_id: app });
    const waiting = await overview(app);
    expect(waiting).toMatchObject({ next_action: "Waiting for the candidate's approval", overdue: false });
    expect(waiting!.next_action_due).toBe(new Date(req.data.expires_at).toISOString().slice(0, 10));

    await service.from("submission_consents").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", req.data.consent_id);
    expect((await overview(app))!.next_action).toBe("Ask for approval again");
  });

  it("is visible to the agency's staff only", async () => {
    const app = await application(await partner());
    expect(await overview(app, outsider.client)).toBeUndefined();
    expect(await overview(app, admin.client)).toBeDefined();
  });
});

describe("journey stages", () => {
  it("move the submission forward, keep the application in step and log each change", async () => {
    const app = await application(await partner());
    const id = await grantAndSubmit(app);
    expect(await overview(app)).toMatchObject({ journey_stage: "submitted", next_action: expect.stringMatching(/^Chase .* for a review$/), next_action_due: daysFromNow(3) });

    expect((await stage(id, 1, "interview")).data).toMatchObject({ stage: "interview", version: 2 });
    expect((await stage(id, 1, "offer")).error?.code).toBe("PT409");
    expect((await stage(id, 2, "offer")).error).toBeNull();
    let { data: a } = await service.from("job_applications").select("stage").eq("id", app).single();
    expect(a!.stage).toBe("offered");

    expect((await stage(id, 3, "started")).error).toMatchObject({ code: "PT400", message: "Give the assignment start date" });
    expect((await stage(id, 3, "started", null, daysFromNow(30), daysFromNow(10))).error)
      .toMatchObject({ code: "PT400", message: expect.stringMatching(/can't end before/) });
    expect((await stage(id, 3, "started", null, daysFromNow(-60), daysFromNow(30))).error).toBeNull();
    ({ data: a } = await service.from("job_applications").select("stage").eq("id", app).single());
    expect(a!.stage).toBe("hired");
    expect(await overview(app)).toMatchObject({ next_action: "Plan the next assignment", next_action_due: daysFromNow(2), overdue: false });

    const { data: events } = await service.from("application_events").select("event_type, details").eq("application_id", app).eq("event_type", "journey_stage_changed");
    expect(events!.map((e) => (e.details as { to: string }).to)).toEqual(["interview", "offer", "started"]);
  });

  it("need a reason to end, and leave the overview when they end", async () => {
    const app = await application(await partner());
    const id = await grantAndSubmit(app);
    expect((await stage(id, 1, "declined")).error).toMatchObject({ code: "PT400", message: expect.stringMatching(/reason/) });
    expect((await stage(id, 1, "submitted")).error).toMatchObject({ code: "PT400", message: "Nothing changed" });
    expect((await stage(id, 1, "declined", "Partner filled the role")).error).toBeNull();
    expect(await overview(app)).toBeUndefined();
    expect((await recruiter.client.rpc("update_journey_stage", {
      p_submission_id: id, p_expected_version: 2, p_stage: "interview", p_note: null, p_start_on: null, p_end_on: null,
    })).error).toBeNull();
    expect((await outsider.client.rpc("update_journey_stage", {
      p_submission_id: id, p_expected_version: 3, p_stage: "offer", p_note: null, p_start_on: null, p_end_on: null,
    })).error?.code).toBe("PT404");
  });

  it("is overdue once the next action's date has passed", async () => {
    const app = await application(await partner());
    const id = await grantAndSubmit(app);
    await service.from("partner_submissions").update({ stage_updated_at: new Date(Date.now() - 5 * 86400000).toISOString() }).eq("id", id);
    expect(await overview(app)).toMatchObject({ overdue: true, next_action_due: daysFromNow(-2) });
  });
});

describe("checklist", () => {
  it("starts from the partner's requirements on submission, due relative to the start date", async () => {
    const p = await partner([
      { title: "Skills checklist", owner: "candidate", due_days_before_start: 14 },
      { title: "Reference check", owner: "partner" },
    ]);
    const { data: reqs } = await recruiter.client.from("partner_requirements").select("title, owner, position").eq("partner_id", p).order("position");
    expect(reqs).toEqual([
      { title: "Skills checklist", owner: "candidate", position: 0 },
      { title: "Reference check", owner: "partner", position: 1 },
    ]);
    const app = await application(p);
    await recruiter.client.rpc("add_journey_item", { p_application_id: app, p_title: "skills CHECKLIST", p_owner: "candidate", p_due_on: null, p_note: null });
    await grantAndSubmit(app);

    const { data: items } = await recruiter.client.from("journey_items").select("title, owner, due_on, source").eq("application_id", app).order("created_at");
    expect(items).toEqual([
      { title: "skills CHECKLIST", owner: "candidate", due_on: null, source: "manual" },
      { title: "Reference check", owner: "partner", due_on: null, source: "partner_requirement" },
    ]);
    expect((await overview(app))!.missing_items).toBe(2);
  });

  it("only admins set requirements, and they're validated", async () => {
    const p = await partner();
    expect((await recruiter.client.rpc("set_partner_requirements", { p_partner_id: p, p_requirements: [] })).error?.code).toBe("PT403");
    expect((await admin.client.rpc("set_partner_requirements", { p_partner_id: p, p_requirements: [{ title: " " }] })).error?.code).toBe("PT400");
    expect((await admin.client.rpc("set_partner_requirements", { p_partner_id: p, p_requirements: [{ title: "X", owner: "boss" }] })).error?.code).toBe("PT400");
    expect((await outsider.client.rpc("set_partner_requirements", { p_partner_id: p, p_requirements: [] })).error?.code).toBe("PT404");
  });

  it("items are received or waived with a reason, and drive credentialing actions", async () => {
    const app = await application(await partner());
    const id = await grantAndSubmit(app);
    const add = await recruiter.client.rpc("add_journey_item", { p_application_id: app, p_title: "TB test", p_owner: "candidate", p_due_on: daysFromNow(-1), p_note: null });
    await recruiter.client.rpc("add_journey_item", { p_application_id: app, p_title: "BLS card", p_owner: "candidate", p_due_on: daysFromNow(5), p_note: null });
    await stage(id, 1, "credentialing");
    expect(await overview(app)).toMatchObject({ next_action: "Collect 2 missing items", next_action_due: daysFromNow(-1), overdue: true, missing_items: 2 });

    const set = (version: number, status: string, note: string | null = null) =>
      recruiter.client.rpc("set_journey_item_status", { p_item_id: add.data.id, p_expected_version: version, p_status: status, p_note: note });
    expect((await set(1, "waived")).error).toMatchObject({ code: "PT400", message: expect.stringMatching(/why/) });
    expect((await set(1, "received")).data).toMatchObject({ status: "received", version: 2 });
    expect((await set(1, "needed")).error?.code).toBe("PT409");
    expect(await overview(app)).toMatchObject({ next_action: "Collect 1 missing item", next_action_due: daysFromNow(5), overdue: false });

    const { data: item } = await service.from("journey_items").select("completed_by, completed_at").eq("id", add.data.id).single();
    expect(item!.completed_by).toBe(recruiter.id);
    expect((await recruiter.client.rpc("add_journey_item", { p_application_id: app, p_title: " ", p_owner: "nest", p_due_on: null, p_note: null })).error?.code).toBe("PT400");
    expect((await outsider.client.rpc("add_journey_item", { p_application_id: app, p_title: "X", p_owner: "nest", p_due_on: null, p_note: null })).error?.code).toBe("PT404");
  });
});
