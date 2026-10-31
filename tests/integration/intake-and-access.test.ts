// Required verification items 1, 2, 4 and 6 from the backend brief, exercised
// with the real anon and authenticated roles through PostgREST.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { addMember, anon, createOrganization, createUser, inquiryPayload, runId, service, submit } from "./setup.ts";

let orgA: { id: string; slug: string };
let orgB: { id: string; slug: string };
let adminA: { id: string; client: SupabaseClient };
let recruiterA: { id: string; client: SupabaseClient };
let recruiterB: { id: string; client: SupabaseClient };
let outsider: { id: string; client: SupabaseClient };
let inquiryA: string;
let inquiryB: string;

beforeAll(async () => {
  orgA = await createOrganization("a");
  orgB = await createOrganization("b");
  [adminA, recruiterA, recruiterB, outsider] = await Promise.all([
    createUser("admin-a"), createUser("recruiter-a"), createUser("recruiter-b"), createUser("outsider"),
  ]);
  await addMember(orgA.id, adminA.id, "admin");
  await addMember(orgA.id, recruiterA.id, "recruiter");
  await addMember(orgB.id, recruiterB.id, "recruiter");

  inquiryA = (await submit(orgA.slug, inquiryPayload())).inquiry_id!;
  inquiryB = (await submit(orgB.slug, inquiryPayload())).inquiry_id!;
});

describe("1. intake saves an inquiry and queues notifications", () => {
  it("stores the inquiry, a submitted event, and two outbox rows", async () => {
    const payload = inquiryPayload({ housing_assistance_requested: true });
    const result = await submit(orgA.slug, payload);
    expect(result.status).toBe("created");

    const { data: inquiry } = await service.from("inquiries").select().eq("id", result.inquiry_id!).single();
    expect(inquiry).toMatchObject({
      organization_id: orgA.id, inquiry_type: "clinician", stage: "new",
      email: payload.email, housing_assistance_requested: true,
    });

    const { data: events } = await service.from("inquiry_events").select().eq("inquiry_id", result.inquiry_id!);
    expect(events).toHaveLength(1);
    expect(events![0]).toMatchObject({ event_type: "submitted", to_stage: "new" });

    const { data: outbox } = await service.from("notification_outbox").select()
      .eq("inquiry_id", result.inquiry_id!).order("template");
    expect(outbox!.map((r) => [r.template, r.recipient, r.status])).toEqual([
      ["clinician_inquiry_confirmation", payload.email, "pending"],
      ["staff_new_inquiry_alert", "alerts-a@example.com", "pending"],
    ]);
    // Contact details are not copied into notification payloads.
    for (const row of outbox!) {
      expect(JSON.stringify(row.template_data)).not.toContain(payload.email);
      expect(JSON.stringify(row.template_data)).not.toContain(payload.full_name);
    }
  });

  it("skips the staff alert when the organization has no alert inbox", async () => {
    const quiet = await createOrganization("quiet", null);
    const result = await submit(quiet.slug, inquiryPayload());
    const { data } = await service.from("notification_outbox").select("template").eq("inquiry_id", result.inquiry_id!);
    expect(data!.map((r) => r.template)).toEqual(["clinician_inquiry_confirmation"]);
  });

  it("collapses an identical resubmission and honours Idempotency-Key retries", async () => {
    const payload = inquiryPayload();
    const first = await submit(orgA.slug, payload);
    const again = await submit(orgA.slug, payload);
    expect(again).toEqual({ status: "duplicate", inquiry_id: first.inquiry_id });

    const key = `retry-${runId}`;
    const keyed = await submit(orgA.slug, inquiryPayload(), key);
    const retried = await submit(orgA.slug, inquiryPayload(), key);
    expect(retried).toEqual({ status: "duplicate", inquiry_id: keyed.inquiry_id });

    const { count } = await service.from("notification_outbox").select("*", { count: "exact", head: true })
      .in("inquiry_id", [first.inquiry_id!, keyed.inquiry_id!]);
    expect(count).toBe(4);
  });

  it("rate-limits by client and by email address", async () => {
    const clientHash = `client-${runId}`;
    const results = [];
    for (let i = 0; i < 6; i++) results.push((await submit(orgA.slug, inquiryPayload(), null, clientHash)).status);
    expect(results).toEqual(["created", "created", "created", "created", "created", "rate_limited"]);

    const email = `repeat-${runId}@example.com`;
    const byEmail = [];
    for (const specialty of ["ICU", "ER", "OR", "L&D"]) {
      byEmail.push((await submit(orgA.slug, inquiryPayload({ email, specialty }))).status);
    }
    expect(byEmail).toEqual(["created", "created", "created", "rate_limited"]);
  });

  it("rejects unknown organizations and invalid data at the database", async () => {
    await expect(submit(`missing-${runId}`, inquiryPayload())).rejects.toMatchObject({ message: "Unknown intake organization" });
    await expect(submit(orgA.slug, inquiryPayload({ full_name: "x" }))).rejects.toBeTruthy();
  });
});

describe("2. anonymous visitors cannot read or write private data", () => {
  it.each([
    "inquiries", "inquiry_events", "profiles", "organizations", "organization_memberships",
    "notification_outbox", "audit_events", "intake_rate_limits",
  ])("anon reads nothing from %s", async (table) => {
    const { data } = await anon().from(table).select("*").limit(1);
    expect(data ?? []).toEqual([]);
  });

  it("anon cannot insert inquiries or call service-only functions", async () => {
    const client = anon();
    const insert = await client.from("inquiries").insert({ organization_id: orgA.id, ...inquiryPayload(), submission_fingerprint: "x", consent_given_at: new Date().toISOString() });
    expect(insert.error).not.toBeNull();
    const rpc = await client.rpc("submit_inquiry", { p_organization_slug: orgA.slug, p_inquiry: inquiryPayload() });
    expect(rpc.error).not.toBeNull();
    const claim = await client.rpc("claim_notifications", {});
    expect(claim.error).not.toBeNull();
  });
});

describe("4. recruiters only see their own organization's records", () => {
  it("each recruiter sees only their organization's inquiries", async () => {
    const a = await recruiterA.client.from("inquiries").select("id, organization_id");
    const b = await recruiterB.client.from("inquiries").select("id, organization_id");
    expect(a.error).toBeNull();
    expect(a.data!.some((r) => r.id === inquiryA)).toBe(true);
    expect(a.data!.every((r) => r.organization_id === orgA.id)).toBe(true);
    expect(b.data!.map((r) => r.id)).toEqual([inquiryB]);
  });

  it("a recruiter cannot fetch another organization's inquiry or its events by id", async () => {
    const { data } = await recruiterA.client.from("inquiries").select().eq("id", inquiryB);
    expect(data).toEqual([]);
    const events = await recruiterA.client.from("inquiry_events").select().eq("inquiry_id", inquiryB);
    expect(events.data).toEqual([]);
  });

  it("notification history is visible to the organization's admins only", async () => {
    const admin = await adminA.client.from("notification_outbox").select("organization_id");
    expect(admin.data!.length).toBeGreaterThan(0);
    expect(admin.data!.every((r) => r.organization_id === orgA.id)).toBe(true);
    const recruiter = await recruiterA.client.from("notification_outbox").select("id");
    expect(recruiter.data).toEqual([]);
  });

  it("a signed-in user without a membership sees nothing", async () => {
    for (const table of ["inquiries", "organizations", "organization_memberships", "notification_outbox"]) {
      const { data } = await outsider.client.from(table).select("*");
      expect(data).toEqual([]);
    }
  });
});

describe("6. users cannot promote themselves or change protected fields", () => {
  it("a user cannot grant themselves a membership", async () => {
    const { error } = await outsider.client.from("organization_memberships")
      .insert({ organization_id: orgA.id, user_id: outsider.id, role: "admin" });
    expect(error).not.toBeNull();
    const { count } = await service.from("organization_memberships").select("*", { count: "exact", head: true })
      .eq("user_id", outsider.id);
    expect(count).toBe(0);
  });

  it("a recruiter cannot upgrade their own role", async () => {
    await recruiterA.client.from("organization_memberships").update({ role: "admin" }).eq("user_id", recruiterA.id);
    const { data } = await service.from("organization_memberships").select("role").eq("user_id", recruiterA.id).single();
    expect(data!.role).toBe("recruiter");
  });

  it("a recruiter cannot move an inquiry to another organization or edit it directly", async () => {
    await recruiterA.client.from("inquiries").update({ organization_id: orgB.id, stage: "placed" }).eq("id", inquiryA);
    const { data } = await service.from("inquiries").select("organization_id, stage").eq("id", inquiryA).single();
    expect(data).toEqual({ organization_id: orgA.id, stage: "new" });
  });

  it("profiles allow editing your own name and phone only", async () => {
    const own = await outsider.client.from("profiles").update({ full_name: "Renamed Tester" }).eq("id", outsider.id).select();
    expect(own.error).toBeNull();
    expect(own.data![0].full_name).toBe("Renamed Tester");

    const idChange = await outsider.client.from("profiles").update({ id: recruiterA.id }).eq("id", outsider.id);
    expect(idChange.error).not.toBeNull();

    await outsider.client.from("profiles").update({ full_name: "Hijacked" }).eq("id", recruiterA.id);
    const { data } = await service.from("profiles").select("full_name").eq("id", recruiterA.id).single();
    expect(data!.full_name).not.toBe("Hijacked");
  });

  it("signed-in users cannot call service-only functions", async () => {
    const { error } = await recruiterA.client.rpc("submit_inquiry", { p_organization_slug: orgA.slug, p_inquiry: inquiryPayload() });
    expect(error).not.toBeNull();
    const complete = await adminA.client.rpc("complete_notification", { p_id: inquiryA, p_success: true });
    expect(complete.error).not.toBeNull();
  });
});
