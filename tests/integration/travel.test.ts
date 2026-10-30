// Location and travel: the facility location on a job, the per diem cache and
// the travel checklist. The GSA lookup itself is in tests/unit/travel.test.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { addMember, createOrganization, createUser, runId, service } from "./setup.ts";

type User = { id: string; client: SupabaseClient };

let org: { id: string };
let recruiter: User;
let outsider: User;

beforeAll(async () => {
  org = await createOrganization("travel");
  const other = await createOrganization("travel-other");
  [recruiter, outsider] = await Promise.all([createUser("travel-recruiter"), createUser("travel-outsider")]);
  await addMember(org.id, recruiter.id, "recruiter");
  await addMember(other.id, outsider.id, "admin");
});

const daysFromNow = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

async function job(startDate: string | null = daysFromNow(40)) {
  const { data, error } = await recruiter.client.rpc("create_job", {
    p_organization_id: org.id,
    p_job: { title: "Travel RN, Tele", specialty: "Telemetry", employment_type: "travel", city: "Austin", state: "TX", start_date: startDate, openings: 1 },
    p_internal: { facility_name: "Synthetic Medical Center" },
  });
  if (error) throw error;
  return data as { id: string; version: number };
}

describe("facility location", () => {
  it("is saved with the job's version, logged, and kept off the public listing", async () => {
    const j = await job();
    const set = (version: number, address: string | null, zip: string | null, client = recruiter.client) =>
      client.rpc("set_job_location", { p_job_id: j.id, p_expected_version: version, p_facility_address: address, p_facility_zip: zip });

    expect((await set(1, " 100 Synthetic Way ", "78701")).data).toMatchObject({ version: 2 });
    expect((await set(1, "x", null)).error?.code).toBe("PT409");
    expect((await set(2, "100 Synthetic Way", "78701")).error).toMatchObject({ code: "PT400", message: "Nothing changed" });
    expect((await set(2, null, "787")).error).toMatchObject({ code: "PT400", message: "Give a 5-digit ZIP code" });
    expect((await set(2, null, null, outsider.client)).error?.code).toBe("PT404");

    const { data } = await service.from("job_internal_details").select("facility_address, facility_zip").eq("job_id", j.id).single();
    expect(data).toEqual({ facility_address: "100 Synthetic Way", facility_zip: "78701" });
    const { data: events } = await service.from("job_events").select("details").eq("job_id", j.id).eq("event_type", "updated");
    expect(events).toEqual([{ details: { fields: ["facility_address", "facility_zip"] } }]);

    // Editing the job keeps the location.
    const { data: current } = await service.from("jobs").select("version").eq("id", j.id).single();
    const edit = await recruiter.client.rpc("update_job", {
      p_job_id: j.id, p_expected_version: current!.version,
      p_job: { title: "Travel RN, Telemetry", specialty: "Telemetry", employment_type: "travel", city: "Austin", state: "TX", start_date: daysFromNow(40), openings: 1 },
      p_internal: { facility_name: "Synthetic Medical Center" },
    });
    expect(edit.error).toBeNull();
    const { data: after } = await service.from("job_internal_details").select("facility_zip").eq("job_id", j.id).single();
    expect(after!.facility_zip).toBe("78701");
  });
});

describe("per diem cache", () => {
  it("is readable by staff and written only by the service role", async () => {
    const row = {
      fiscal_year: 2027, lookup_key: `city:TX:test-${runId}`, state: "TX", gsa_location: "Standard Rate", county: null,
      is_standard: true, lodging_by_month: Array(12).fill(110), meals_daily: 68,
    };
    expect((await recruiter.client.from("per_diem_rates").insert({ ...row, lookup_key: `city:TX:x-${runId}` })).error).not.toBeNull();
    expect((await service.from("per_diem_rates").insert(row)).error).toBeNull();
    expect((await recruiter.client.from("per_diem_rates").select("meals_daily").eq("lookup_key", row.lookup_key)).data).toEqual([{ meals_daily: 68 }]);
    expect((await service.from("per_diem_rates").insert({ ...row, lookup_key: "zip:7870" })).error).not.toBeNull();
    expect((await service.from("per_diem_rates").insert({ ...row, lookup_key: `zip:78702`, lodging_by_month: [1, 2] })).error).not.toBeNull();
  });
});

describe("travel checklist", () => {
  it("adds the travel steps due before the start date, once", async () => {
    const j = await job(daysFromNow(40));
    const opened = await recruiter.client.rpc("set_job_status", { p_job_id: j.id, p_expected_version: j.version, p_status: "open" });
    expect(opened.error).toBeNull();
    const { data: app } = await service.from("job_applications").insert({
      job_id: j.id, organization_id: org.id, source: "recruiter", full_name: "Travel Candidate", email: `travel-${runId}@example.com`,
    }).select("id").single();
    await recruiter.client.rpc("add_journey_item", { p_application_id: app!.id, p_title: "housing arranged", p_owner: "candidate", p_due_on: null, p_note: null });

    expect((await recruiter.client.rpc("add_travel_checklist", { p_application_id: app!.id })).data).toEqual({ added: 5 });
    expect((await recruiter.client.rpc("add_travel_checklist", { p_application_id: app!.id })).data).toEqual({ added: 0 });
    expect((await outsider.client.rpc("add_travel_checklist", { p_application_id: app!.id })).error?.code).toBe("PT404");

    const { data: items } = await service.from("journey_items").select("title, owner, due_on, source").eq("application_id", app!.id).order("created_at");
    expect(items![0]).toMatchObject({ title: "housing arranged", source: "manual" });
    // Added in one statement, so they share a created_at: compare by title.
    const byTitle = (x: { title: string }, y: { title: string }) => x.title.localeCompare(y.title);
    expect(items!.slice(1).sort(byTitle)).toEqual([
      { title: "License valid in the assignment state (or compact privilege)", owner: "partner", due_on: daysFromNow(19), source: "travel" },
      { title: "Stipend eligibility (tax home) confirmed by the partner", owner: "partner", due_on: daysFromNow(26), source: "travel" },
      { title: "Travel to the assignment planned", owner: "candidate", due_on: daysFromNow(33), source: "travel" },
      { title: "Commute and parking planned", owner: "candidate", due_on: daysFromNow(33), source: "travel" },
      { title: "First-day details sent (address, time, who to ask for)", owner: "partner", due_on: daysFromNow(37), source: "travel" },
    ].sort(byTitle));
  });
});
