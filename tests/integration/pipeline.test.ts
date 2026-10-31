// Phase 2 staff pipeline: stage changes, notes and assignment go through
// validated functions, run here as real anon and signed-in users.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { addMember, anon, createOrganization, createUser, inquiryPayload, service, submit } from "./setup.ts";

type User = { id: string; client: SupabaseClient };

let orgA: { id: string; slug: string };
let orgB: { id: string; slug: string };
let adminA: User;
let recruiterA: User;
let recruiterB: User;
let outsider: User;

beforeAll(async () => {
  orgA = await createOrganization("pipe-a");
  orgB = await createOrganization("pipe-b");
  [adminA, recruiterA, recruiterB, outsider] = await Promise.all([
    createUser("pipe-admin-a"), createUser("pipe-recruiter-a"), createUser("pipe-recruiter-b"), createUser("pipe-outsider"),
  ]);
  await addMember(orgA.id, adminA.id, "admin");
  await addMember(orgA.id, recruiterA.id, "recruiter");
  await addMember(orgB.id, recruiterB.id, "recruiter");
});

async function newInquiry(slug = orgA.slug): Promise<string> {
  return (await submit(slug, inquiryPayload())).inquiry_id!;
}

async function current(id: string) {
  const { data, error } = await service.from("inquiries").select().eq("id", id).single();
  if (error) throw error;
  return data;
}

const changeStage = (client: SupabaseClient, id: string, version: number, stage: string, reason: string | null = null) =>
  client.rpc("change_inquiry_stage", { p_inquiry_id: id, p_expected_version: version, p_stage: stage, p_closed_reason: reason });
const assign = (client: SupabaseClient, id: string, version: number, assignee: string | null) =>
  client.rpc("assign_inquiry", { p_inquiry_id: id, p_expected_version: version, p_assignee_id: assignee });
const addNote = (client: SupabaseClient, id: string, body: string) =>
  client.rpc("add_inquiry_note", { p_inquiry_id: id, p_body: body });

describe("stage changes", () => {
  it("moves the stage, bumps the version and records who did it", async () => {
    const id = await newInquiry();
    const { data, error } = await changeStage(recruiterA.client, id, 1, "contacted");
    expect(error).toBeNull();
    expect(data).toMatchObject({ stage: "contacted", version: 2 });

    const { data: events } = await service.from("inquiry_events").select()
      .eq("inquiry_id", id).eq("event_type", "stage_changed");
    expect(events).toEqual([expect.objectContaining({ from_stage: "new", to_stage: "contacted", actor_id: recruiterA.id })]);
  });

  it("rejects a stale version and leaves the inquiry unchanged", async () => {
    const id = await newInquiry();
    await changeStage(recruiterA.client, id, 1, "contacted");
    const { error } = await changeStage(adminA.client, id, 1, "qualified");
    expect(error?.code).toBe("PT409");
    expect(await current(id)).toMatchObject({ stage: "contacted", version: 2 });
  });

  it("lets exactly one of two simultaneous changes win", async () => {
    const id = await newInquiry();
    const results = await Promise.all([
      changeStage(recruiterA.client, id, 1, "contacted"),
      changeStage(adminA.client, id, 1, "qualified"),
    ]);
    expect(results.filter((r) => r.error === null)).toHaveLength(1);
    expect(results.filter((r) => r.error?.code === "PT409")).toHaveLength(1);
    expect((await current(id)).version).toBe(2);
  });

  it("requires a reason to close, and clears it on reopening", async () => {
    const id = await newInquiry();
    const missing = await changeStage(recruiterA.client, id, 1, "closed", "   ");
    expect(missing.error).toMatchObject({ code: "PT400", message: "Give a reason for closing the inquiry" });

    const closed = await changeStage(recruiterA.client, id, 1, "closed", "  Took a staff role elsewhere ");
    expect(closed.error).toBeNull();
    expect(await current(id)).toMatchObject({ stage: "closed", closed_reason: "Took a staff role elsewhere" });

    const reopened = await changeStage(recruiterA.client, id, 2, "contacted");
    expect(reopened.error).toBeNull();
    expect(await current(id)).toMatchObject({ stage: "contacted", closed_reason: null, version: 3 });
  });

  it("rejects a reason on a non-closing change and a no-op change", async () => {
    const id = await newInquiry();
    expect((await changeStage(recruiterA.client, id, 1, "contacted", "why")).error?.code).toBe("PT400");
    expect((await changeStage(recruiterA.client, id, 1, "new")).error?.code).toBe("PT400");
    expect((await current(id)).version).toBe(1);
  });
});

describe("assignment", () => {
  it("assigns to a colleague, reassigns and unassigns", async () => {
    const id = await newInquiry();
    expect((await assign(adminA.client, id, 1, recruiterA.id)).data).toMatchObject({ assigned_recruiter_id: recruiterA.id, version: 2 });
    expect((await assign(recruiterA.client, id, 2, adminA.id)).error).toBeNull();
    expect((await assign(recruiterA.client, id, 3, null)).error).toBeNull();
    expect(await current(id)).toMatchObject({ assigned_recruiter_id: null, version: 4 });

    const { data: events } = await service.from("inquiry_events").select("details, actor_id")
      .eq("inquiry_id", id).eq("event_type", "assigned").order("id");
    expect(events!.map((e) => e.details)).toEqual([
      { from: null, to: recruiterA.id },
      { from: recruiterA.id, to: adminA.id },
      { from: adminA.id, to: null },
    ]);
  });

  it("refuses assignees outside the inquiry's organization", async () => {
    const id = await newInquiry();
    for (const assignee of [recruiterB.id, outsider.id, crypto.randomUUID()]) {
      const { error } = await assign(recruiterA.client, id, 1, assignee);
      expect(error).toMatchObject({ code: "PT400", message: "That person isn't on this agency's staff" });
    }
    expect((await current(id)).assigned_recruiter_id).toBeNull();
  });

  it("lists assignable staff only to that organization's staff", async () => {
    const { data } = await recruiterA.client.rpc("organization_staff", { p_organization_id: orgA.id });
    expect(new Set(data!.map((s: { user_id: string }) => s.user_id))).toEqual(new Set([adminA.id, recruiterA.id]));

    expect((await recruiterB.client.rpc("organization_staff", { p_organization_id: orgA.id })).error?.code).toBe("PT404");
    expect((await outsider.client.rpc("organization_staff", { p_organization_id: orgA.id })).error?.code).toBe("PT404");
  });
});

describe("notes", () => {
  it("adds trimmed notes that only the organization's staff can read", async () => {
    const id = await newInquiry();
    const { data, error } = await addNote(recruiterA.client, id, "  Left a voicemail.  ");
    expect(error).toBeNull();

    const { data: own } = await adminA.client.from("inquiry_notes").select().eq("inquiry_id", id);
    expect(own).toEqual([expect.objectContaining({ id: data.id, body: "Left a voicemail.", author_id: recruiterA.id })]);

    for (const reader of [recruiterB.client, outsider.client]) {
      const { data: rows } = await reader.from("inquiry_notes").select().eq("inquiry_id", id);
      expect(rows).toEqual([]);
    }
    // Notes don't conflict with stage changes, so they leave the version alone.
    expect((await current(id)).version).toBe(1);
  });

  it("rejects empty and oversized notes", async () => {
    const id = await newInquiry();
    expect((await addNote(recruiterA.client, id, "   ")).error?.code).toBe("PT400");
    expect((await addNote(recruiterA.client, id, "x".repeat(4001))).error?.code).toBe("PT400");
  });
});

describe("access control", () => {
  it("treats another organization's inquiry as not found for every action", async () => {
    const id = await newInquiry(orgB.slug);
    for (const client of [recruiterA.client, outsider.client]) {
      expect((await changeStage(client, id, 1, "contacted")).error?.code).toBe("PT404");
      expect((await assign(client, id, 1, null)).error?.code).toBe("PT404");
      expect((await addNote(client, id, "hello")).error?.code).toBe("PT404");
    }
    expect(await current(id)).toMatchObject({ stage: "new", version: 1 });
    const { count } = await service.from("inquiry_notes").select("*", { count: "exact", head: true }).eq("inquiry_id", id);
    expect(count).toBe(0);
  });

  it("does not let anonymous users call the pipeline functions", async () => {
    const id = await newInquiry();
    const client = anon();
    for (const { error } of [
      await changeStage(client, id, 1, "contacted"),
      await assign(client, id, 1, null),
      await addNote(client, id, "hello"),
      await client.rpc("organization_staff", { p_organization_id: orgA.id }),
    ]) {
      expect(error?.code).toBe("42501");
    }
  });

  it("still blocks direct writes to inquiries, notes and events", async () => {
    const id = await newInquiry();
    const c = recruiterA.client;
    expect((await c.from("inquiries").update({ stage: "placed" }).eq("id", id)).error?.code).toBe("42501");
    expect((await c.from("inquiry_notes").insert({ inquiry_id: id, organization_id: orgA.id, body: "x" })).error?.code).toBe("42501");
    expect((await c.from("inquiry_events").insert({ inquiry_id: id, organization_id: orgA.id, event_type: "x" })).error?.code).toBe("42501");
    expect((await current(id)).stage).toBe("new");
  });
});
