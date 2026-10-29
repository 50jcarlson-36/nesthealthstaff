// Phase 3 jobs and applications: manual job entry with internal fields kept
// out of the public listing, and applications from the website and from
// recruiters.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { addMember, anon, createOrganization, createUser, inquiryPayload, runId, service, submit } from "./setup.ts";

type User = { id: string; client: SupabaseClient };

let orgA: { id: string; slug: string };
let orgB: { id: string; slug: string };
let adminA: User;
let recruiterA: User;
let recruiterB: User;
let outsider: User;

beforeAll(async () => {
  orgA = await createOrganization("jobs-a");
  orgB = await createOrganization("jobs-b");
  [adminA, recruiterA, recruiterB, outsider] = await Promise.all([
    createUser("jobs-admin-a"), createUser("jobs-recruiter-a"), createUser("jobs-recruiter-b"), createUser("jobs-outsider"),
  ]);
  await addMember(orgA.id, adminA.id, "admin");
  await addMember(orgA.id, recruiterA.id, "recruiter");
  await addMember(orgB.id, recruiterB.id, "recruiter");
});

const publicFields = (overrides: Record<string, unknown> = {}) => ({
  title: "Travel RN, Telemetry",
  specialty: "Telemetry",
  employment_type: "travel",
  city: "Austin",
  state: "tx",
  shift: "night",
  hours_per_week: 36,
  start_date: "2026-12-07",
  duration_weeks: 13,
  openings: 2,
  public_description: "  Synthetic test job.  ",
  ...overrides,
});

const internalFields = (overrides: Record<string, unknown> = {}) => ({
  facility_name: "Synthetic Regional Medical Center",
  facility_contact: "Nurse manager, synthetic",
  source: "direct_contract",
  requisition_reference: "REQ-TEST-1",
  rate_notes: "SYNTHETIC-RATE-NOTE",
  internal_notes: "SYNTHETIC-INTERNAL-NOTE",
  ...overrides,
});

const createJob = (client: SupabaseClient, orgId: string, job = publicFields(), internal = internalFields()) =>
  client.rpc("create_job", { p_organization_id: orgId, p_job: job, p_internal: internal });
const setStatus = (client: SupabaseClient, id: string, version: number, status: string) =>
  client.rpc("set_job_status", { p_job_id: id, p_expected_version: version, p_status: status });
const updateJob = (client: SupabaseClient, id: string, version: number, job: object, internal: object) =>
  client.rpc("update_job", { p_job_id: id, p_expected_version: version, p_job: job, p_internal: internal });
const changeStage = (client: SupabaseClient, id: string, version: number, stage: string, reason: string | null = null) =>
  client.rpc("change_application_stage", { p_application_id: id, p_expected_version: version, p_stage: stage, p_reason: reason });
const addFromInquiry = (client: SupabaseClient, jobId: string, inquiryId: string) =>
  client.rpc("add_application_from_inquiry", { p_job_id: jobId, p_inquiry_id: inquiryId });

let applicant = 0;
function application(overrides: Record<string, unknown> = {}) {
  applicant++;
  return { full_name: "Test Applicant", email: `applicant-${runId}-${applicant}@example.com`, phone: null, consent_version: "test", ...overrides };
}
async function apply(slug: string, jobId: string, body: Record<string, unknown>, clientHash: string | null = null) {
  const { data, error } = await service.rpc("submit_job_application", {
    p_organization_slug: slug, p_job_id: jobId, p_application: body, p_client_hash: clientHash,
  });
  if (error) throw error;
  return data as { status: string; application_id?: string };
}

// A job in orgA, opened so it's published and takes applications.
async function openJob(): Promise<string> {
  const { data, error } = await createJob(recruiterA.client, orgA.id);
  if (error) throw error;
  const opened = await setStatus(recruiterA.client, data.id, 1, "open");
  if (opened.error) throw opened.error;
  return data.id;
}

async function job(id: string) {
  const { data, error } = await service.from("jobs").select().eq("id", id).single();
  if (error) throw error;
  return data;
}

describe("job entry", () => {
  it("creates a draft with trimmed public fields and separate internal details", async () => {
    const { data, error } = await createJob(recruiterA.client, orgA.id);
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: "draft", version: 1 });

    expect(await job(data.id)).toMatchObject({
      state: "TX", public_description: "Synthetic test job.", created_by: recruiterA.id, published_at: null,
    });
    const { data: internal } = await adminA.client.from("job_internal_details").select().eq("job_id", data.id).single();
    expect(internal).toMatchObject({ facility_name: "Synthetic Regional Medical Center", rate_notes: "SYNTHETIC-RATE-NOTE" });
  });

  it("rejects missing and malformed fields with readable messages", async () => {
    const cases: [object, object, string][] = [
      [publicFields({ title: "  " }), internalFields(), "Give the job a title"],
      [publicFields({ state: "Texas" }), internalFields(), "Use a two-letter state code, like TX"],
      [publicFields({ employment_type: "gig" }), internalFields(), "Check the job details: a value is in the wrong format"],
      [publicFields({ start_date: "next week" }), internalFields(), "Check the job details: a value is in the wrong format"],
      [publicFields({ hours_per_week: 100 }), internalFields(), "Hours per week must be between 1 and 84"],
      [publicFields(), internalFields({ facility_name: "" }), "Give the facility name"],
      [publicFields(), internalFields({ rate_notes: "x".repeat(2001) }), "Keep the rate notes under 2000 characters"],
    ];
    for (const [pub, internal, message] of cases) {
      const { error } = await createJob(recruiterA.client, orgA.id, pub as never, internal as never);
      expect(error).toMatchObject({ code: "PT400", message });
    }
  });

  it("refuses to create jobs for an organization the caller isn't staff of", async () => {
    for (const client of [recruiterB.client, outsider.client]) {
      expect((await createJob(client, orgA.id)).error?.code).toBe("PT404");
    }
    expect((await createJob(anon(), orgA.id)).error?.code).toBe("42501");
  });

  it("updates fields with a version check and records which fields changed", async () => {
    const { data } = await createJob(recruiterA.client, orgA.id);
    const edited = await updateJob(recruiterA.client, data.id, 1, publicFields({ openings: 3 }), internalFields({ rate_notes: "SYNTHETIC-RATE-2" }));
    expect(edited.error).toBeNull();
    expect(edited.data).toMatchObject({ version: 2 });

    const stale = await updateJob(adminA.client, data.id, 1, publicFields({ openings: 4 }), internalFields());
    expect(stale.error?.code).toBe("PT409");
    expect((await job(data.id)).openings).toBe(3);

    const same = await updateJob(recruiterA.client, data.id, 2, publicFields({ openings: 3 }), internalFields({ rate_notes: "SYNTHETIC-RATE-2" }));
    expect(same.error).toMatchObject({ code: "PT400", message: "Nothing changed" });

    // The history names fields, never values, so rates don't spread.
    const { data: events } = await service.from("job_events").select("details").eq("job_id", data.id).eq("event_type", "updated");
    expect(events).toEqual([{ details: { fields: ["openings", "rate_notes"] } }]);
  });
});

describe("job status and the public listing", () => {
  it("lists only open jobs, and only public fields", async () => {
    const { data: draft } = await createJob(recruiterA.client, orgA.id, publicFields({ title: "Draft job" }));
    const opened = await openJob();
    // Internal fields sent in the public object are ignored, not published.
    const { data: sneaky } = await createJob(recruiterA.client, orgA.id, publicFields({ facility_name: "LEAKED", rate_notes: "LEAKED" }) as never);
    await setStatus(recruiterA.client, sneaky.id, 1, "open");

    const { data, error } = await anon().rpc("list_public_jobs", { p_organization_slug: orgA.slug });
    expect(error).toBeNull();
    const ids = data.map((j: { id: string }) => j.id);
    expect(ids).toContain(opened);
    expect(ids).toContain(sneaky.id);
    expect(ids).not.toContain(draft.id);

    const text = JSON.stringify(data);
    for (const secret of ["Synthetic Regional", "SYNTHETIC-RATE", "SYNTHETIC-INTERNAL", "REQ-TEST", "LEAKED", orgA.id]) {
      expect(text).not.toContain(secret);
    }
    expect(Object.keys(data[0]).sort()).toEqual([
      "city", "duration_weeks", "employment_type", "hours_per_week", "id", "openings", "public_description",
      "published_at", "shift", "specialty", "start_date", "state", "title",
    ]);

    // Another agency's board doesn't include these jobs.
    const { data: other } = await anon().rpc("list_public_jobs", { p_organization_slug: orgB.slug });
    expect(other.map((j: { id: string }) => j.id)).not.toContain(opened);
  });

  it("keeps anonymous users and other agencies away from the job tables", async () => {
    const id = await openJob();
    for (const table of ["jobs", "job_internal_details", "job_applications"]) {
      expect((await anon().from(table).select()).error?.code).toBe("42501");
    }
    for (const client of [recruiterB.client, outsider.client]) {
      expect((await client.from("jobs").select().eq("id", id)).data).toEqual([]);
      expect((await client.from("job_internal_details").select().eq("job_id", id)).data).toEqual([]);
      expect((await setStatus(client, id, 2, "closed")).error?.code).toBe("PT404");
    }
    expect((await recruiterA.client.from("jobs").update({ status: "closed" }).eq("id", id)).error?.code).toBe("42501");
    expect((await recruiterA.client.from("job_internal_details").update({ rate_notes: "x" }).eq("job_id", id)).error?.code).toBe("42501");
    expect((await job(id)).status).toBe("open");
  });

  it("sets published_at once and won't send a published job back to draft", async () => {
    const id = await openJob();
    const first = (await job(id)).published_at;
    expect(first).not.toBeNull();
    expect((await setStatus(recruiterA.client, id, 2, "on_hold")).error).toBeNull();
    expect((await setStatus(recruiterA.client, id, 3, "draft")).error?.message).toMatch(/can't go back to draft/);
    expect((await setStatus(recruiterA.client, id, 3, "open")).error).toBeNull();
    expect(await job(id)).toMatchObject({ status: "open", published_at: first, version: 4 });
    expect((await setStatus(recruiterA.client, id, 4, "open")).error?.code).toBe("PT400");
  });
});

describe("website applications", () => {
  it("saves an application to an open job with consent", async () => {
    const id = await openJob();
    const body = application({ full_name: "  Pat Applicant ", email: ` Pat.${runId}@Example.com ` });
    const result = await apply(orgA.slug, id, body);
    expect(result.status).toBe("created");
    const { data } = await recruiterA.client.from("job_applications").select().eq("id", result.application_id!).single();
    expect(data).toMatchObject({ full_name: "Pat Applicant", email: `pat.${runId}@example.com`, source: "website", stage: "applied" });
    expect(data.consent_given_at).not.toBeNull();
  });

  it("returns the original application for a duplicate, including simultaneous ones", async () => {
    const id = await openJob();
    const body = application();
    const first = await apply(orgA.slug, id, body);
    const again = await apply(orgA.slug, id, { ...body, email: body.email.toUpperCase() });
    expect(again).toEqual({ status: "duplicate", application_id: first.application_id });

    const racing = application();
    const results = await Promise.all([apply(orgA.slug, id, racing), apply(orgA.slug, id, racing), apply(orgA.slug, id, racing)]);
    expect(results.filter((r) => r.status === "created")).toHaveLength(1);
    expect(new Set(results.map((r) => r.application_id)).size).toBe(1);
    const { count } = await service.from("job_applications").select("*", { count: "exact", head: true })
      .eq("job_id", id).eq("email", racing.email);
    expect(count).toBe(1);
  });

  it("rejects applications to jobs that aren't open", async () => {
    const { data: draft } = await createJob(recruiterA.client, orgA.id);
    expect((await apply(orgA.slug, draft.id, application())).status).toBe("job_closed");

    const id = await openJob();
    for (const [version, status] of [[2, "on_hold"], [3, "filled"], [4, "closed"]] as const) {
      await setStatus(recruiterA.client, id, version, status);
      expect((await apply(orgA.slug, id, application())).status).toBe("job_closed");
    }
    const { count } = await service.from("job_applications").select("*", { count: "exact", head: true }).eq("job_id", id);
    expect(count).toBe(0);
  });

  it("treats a job from another agency's slug, or a random id, as not found", async () => {
    const id = await openJob();
    expect((await apply(orgB.slug, id, application())).status).toBe("job_not_found");
    expect((await apply(orgA.slug, crypto.randomUUID(), application())).status).toBe("job_not_found");
  });

  it("validates applicant details and requires consent", async () => {
    const id = await openJob();
    for (const body of [application({ full_name: " " }), application({ email: "not-an-email" }), application({ consent_version: null })]) {
      const { error } = await service.rpc("submit_job_application", { p_organization_slug: orgA.slug, p_job_id: id, p_application: body });
      expect(error?.code).toBe("PT400");
    }
  });

  it("can only be called by the server", async () => {
    const id = await openJob();
    for (const client of [anon(), recruiterA.client]) {
      const { error } = await client.rpc("submit_job_application", { p_organization_slug: orgA.slug, p_job_id: id, p_application: application() });
      expect(error?.code).toBe("42501");
    }
  });

  it("rate-limits one client across jobs", async () => {
    const id = await openJob();
    const hash = `test-${runId}-apply`;
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await apply(orgA.slug, id, application(), hash)).status);
    expect(statuses.slice(0, 10).every((s) => s === "created")).toBe(true);
    expect(statuses[10]).toBe("rate_limited");
  });
});

describe("recruiter applications", () => {
  it("puts forward a clinician inquiry, copying their details", async () => {
    const id = await openJob();
    const inquiry = (await submit(orgA.slug, inquiryPayload({ full_name: "Inquiry Clinician" }))).inquiry_id!;
    const { data, error } = await addFromInquiry(adminA.client, id, inquiry);
    expect(error).toBeNull();
    const { data: row } = await service.from("job_applications").select().eq("id", data.id).single();
    expect(row).toMatchObject({ full_name: "Inquiry Clinician", inquiry_id: inquiry, source: "recruiter", created_by: adminA.id, consent_version: null });

    expect((await addFromInquiry(recruiterA.client, id, inquiry)).error).toMatchObject({
      code: "PT400", message: "This clinician has already applied to this job",
    });
  });

  it("refuses facility inquiries, another agency's inquiries and closed jobs", async () => {
    const id = await openJob();
    const facility = (await submit(orgA.slug, inquiryPayload({ inquiry_type: "facility", organization_name: "Synthetic Hospital" }))).inquiry_id!;
    const otherAgency = (await submit(orgB.slug, inquiryPayload())).inquiry_id!;
    for (const inquiry of [facility, otherAgency, crypto.randomUUID()]) {
      expect((await addFromInquiry(recruiterA.client, id, inquiry)).error?.message).toBe("Choose a clinician inquiry from this agency");
    }

    const clinician = (await submit(orgA.slug, inquiryPayload())).inquiry_id!;
    await setStatus(recruiterA.client, id, 2, "filled");
    expect((await addFromInquiry(recruiterA.client, id, clinician)).error?.message).toMatch(/isn't open/);
    // Another agency's staff can't see the job at all.
    expect((await addFromInquiry(recruiterB.client, id, otherAgency)).error?.code).toBe("PT404");
  });

  it("moves applications through stages with reasons, versions and history", async () => {
    const id = await openJob();
    const { application_id } = await apply(orgA.slug, id, application());
    const appId = application_id!;

    expect((await changeStage(recruiterA.client, appId, 1, "screening")).data).toMatchObject({ stage: "screening", version: 2 });
    expect((await changeStage(adminA.client, appId, 1, "submitted")).error?.code).toBe("PT409");
    expect((await changeStage(recruiterA.client, appId, 2, "rejected")).error?.message).toBe("Give a reason");
    expect((await changeStage(recruiterA.client, appId, 2, "submitted", "why")).error?.code).toBe("PT400");
    expect((await changeStage(recruiterA.client, appId, 2, "withdrawn", " Took another offer ")).error).toBeNull();
    expect((await changeStage(recruiterA.client, appId, 3, "screening")).error).toBeNull();

    const { data: row } = await service.from("job_applications").select().eq("id", appId).single();
    expect(row).toMatchObject({ stage: "screening", stage_reason: null, version: 4 });

    const { data: events } = await recruiterA.client.from("application_events")
      .select("event_type, from_stage, to_stage, actor_id, details").eq("application_id", appId).order("id");
    expect(events).toEqual([
      { event_type: "created", from_stage: null, to_stage: "applied", actor_id: null, details: { source: "website" } },
      { event_type: "stage_changed", from_stage: "applied", to_stage: "screening", actor_id: recruiterA.id, details: {} },
      { event_type: "stage_changed", from_stage: "screening", to_stage: "withdrawn", actor_id: recruiterA.id, details: { reason: "Took another offer" } },
      { event_type: "stage_changed", from_stage: "withdrawn", to_stage: "screening", actor_id: recruiterA.id, details: {} },
    ]);
  });

  it("keeps applications inside the agency", async () => {
    const id = await openJob();
    const { application_id } = await apply(orgA.slug, id, application());
    for (const client of [recruiterB.client, outsider.client]) {
      expect((await client.from("job_applications").select().eq("id", application_id!)).data).toEqual([]);
      expect((await client.from("application_events").select().eq("application_id", application_id!)).data).toEqual([]);
      expect((await changeStage(client, application_id!, 1, "screening")).error?.code).toBe("PT404");
    }
    expect((await recruiterA.client.from("job_applications").update({ stage: "hired" }).eq("id", application_id!)).error?.code).toBe("42501");
    expect((await recruiterA.client.from("job_applications").insert({ job_id: id, organization_id: orgA.id, source: "recruiter", full_name: "X Y", email: "x@example.com" })).error?.code).toBe("42501");
  });
});

describe("application emails", () => {
  async function outboxFor(applicationId: string) {
    const { data, error } = await service.from("notification_outbox")
      .select("template, recipient, status, template_data, dedupe_key, organization_id").eq("application_id", applicationId).order("template");
    if (error) throw error;
    return data!;
  }
  const outboxCount = async (column: string, value: string) =>
    (await service.from("notification_outbox").select("*", { count: "exact", head: true }).eq(column, value)).count;

  it("queues a confirmation and a staff alert for a new website application", async () => {
    const id = await openJob();
    const body = application({ full_name: "Morgan Applicant", phone: "555-0199" });
    const { application_id } = await apply(orgA.slug, id, body);

    const rows = await outboxFor(application_id!);
    expect(rows.map((r) => [r.template, r.recipient, r.status, r.dedupe_key])).toEqual([
      ["job_application_confirmation", body.email, "pending", `application:${application_id}:confirmation`],
      ["staff_new_application_alert", `alerts-jobs-a@example.com`, "pending", `application:${application_id}:staff_alert`],
    ]);
    expect(rows[0].template_data).toEqual({ organization_name: "Test jobs-a", job_title: "Travel RN, Telemetry" });
    expect(rows[1].template_data).toEqual({ job_id: id, job_title: "Travel RN, Telemetry", application_id });
    expect(rows.every((r) => r.organization_id === orgA.id)).toBe(true);

    // Payloads carry no applicant details and nothing internal about the job.
    const payloads = JSON.stringify(rows.map((r) => r.template_data));
    for (const secret of [body.email, "Morgan Applicant", "555-0199", "Synthetic Regional", "SYNTHETIC-RATE", "REQ-TEST"]) {
      expect(payloads).not.toContain(secret);
    }
  });

  it("queues nothing more for a duplicate, and nothing for closed or unknown jobs", async () => {
    const id = await openJob();
    const body = application();
    const { application_id } = await apply(orgA.slug, id, body);
    await apply(orgA.slug, id, { ...body, email: body.email.toUpperCase() });
    expect(await outboxFor(application_id!)).toHaveLength(2);

    const closed = await openJob();
    await setStatus(recruiterA.client, closed, 2, "closed");
    const closedApplicant = application();
    expect((await apply(orgA.slug, closed, closedApplicant)).status).toBe("job_closed");
    expect((await apply(orgA.slug, crypto.randomUUID(), closedApplicant)).status).toBe("job_not_found");
    expect(await outboxCount("recipient", closedApplicant.email)).toBe(0);
  });

  it("skips the staff alert when the agency has no alert address", async () => {
    const quiet = await createOrganization("jobs-quiet", null);
    const { data: job } = await service.from("jobs").insert({
      organization_id: quiet.id, status: "open", published_at: new Date().toISOString(),
      title: "Quiet job", specialty: "ICU", employment_type: "travel", city: "Reno", state: "NV",
    }).select("id").single();
    await service.from("job_internal_details").insert({ job_id: job!.id, organization_id: quiet.id, facility_name: "Synthetic" });

    const { application_id } = await apply(quiet.slug, job!.id, application());
    expect((await outboxFor(application_id!)).map((r) => r.template)).toEqual(["job_application_confirmation"]);
  });

  it("sends nothing for a candidate a recruiter puts forward", async () => {
    const id = await openJob();
    const inquiry = (await submit(orgA.slug, inquiryPayload())).inquiry_id!;
    const { data } = await addFromInquiry(recruiterA.client, id, inquiry);
    expect(await outboxFor(data.id)).toEqual([]);
  });
});
