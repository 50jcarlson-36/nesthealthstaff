// Partner connector: exports, API keys, API events and CSV imports. The
// partner-api function only hashes the key and passes requests on, so these
// call its database functions directly with the service role.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { addMember, createOrganization, createUser, runId, service } from "./setup.ts";

type User = { id: string; client: SupabaseClient };

let org: { id: string };
let admin: User;
let recruiter: User;
let outsider: User;

beforeAll(async () => {
  org = await createOrganization("connector");
  const other = await createOrganization("connector-other");
  [admin, recruiter, outsider] = await Promise.all([
    createUser("connector-admin"), createUser("connector-recruiter"), createUser("connector-outsider"),
  ]);
  await addMember(org.id, admin.id, "admin");
  await addMember(org.id, recruiter.id, "recruiter");
  await addMember(other.id, outsider.id, "admin");
});

const daysFromNow = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const hash = (key: string) => createHash("sha256").update(key).digest("hex");

let count = 0;
async function partner() {
  const { data, error } = await admin.client.rpc("create_partner", {
    p_organization_id: org.id,
    p_partner: { name: `Connector Partner ${runId}-${++count}`, status: "active", agreement_signed_on: "2026-10-01", attribution_days: 90 },
  });
  if (error) throw error;
  return data.id as string;
}

// A submitted candidate on an open partner opening.
async function submission(partnerId: string, name = "Connector Candidate") {
  const created = await recruiter.client.rpc("create_job", {
    p_organization_id: org.id,
    p_job: { title: "Travel RN, ICU", specialty: "ICU", employment_type: "travel", city: "Austin", state: "TX", start_date: daysFromNow(30), openings: 1 },
    p_internal: { facility_name: "Synthetic Hospital", internal_notes: "internal only" },
  });
  const opened = await recruiter.client.rpc("set_job_status", { p_job_id: created.data.id, p_expected_version: created.data.version, p_status: "open" });
  await recruiter.client.rpc("set_job_terms", {
    p_job_id: created.data.id, p_expected_version: opened.data.version,
    p_terms: { partner_id: partnerId, partner_reference: "REQ-77", hourly_rate_cents: 9000 },
  });
  const { data: app } = await service.from("job_applications").insert({
    job_id: created.data.id, organization_id: org.id, source: "recruiter",
    full_name: name, email: `connector-${runId}-${++count}@example.com`, phone: "555-0100",
  }).select("id").single();
  const req = await recruiter.client.rpc("request_submission_consent", { p_application_id: app!.id });
  const { data: email } = await service.from("notification_outbox").select("template_data").eq("dedupe_key", `consent:${req.data.consent_id}`).single();
  await service.rpc("respond_submission_consent", { p_token: (email!.template_data as { token: string }).token, p_decision: "granted", p_client_hash: null });
  const submitted = await recruiter.client.rpc("submit_to_partner", { p_application_id: app!.id, p_partner_candidate_reference: null });
  if (submitted.error) throw submitted.error;
  return { id: submitted.data.id as string, applicationId: app!.id as string };
}

async function newKey(partnerId: string) {
  const { data, error } = await admin.client.rpc("create_partner_api_key", { p_partner_id: partnerId, p_label: "ATS" });
  if (error) throw error;
  return data as { id: string; key: string; key_prefix: string };
}

const event = (key: string, body: object) => service.rpc("partner_api_event", { p_key_hash: hash(key), p_event: body });
const exported = (key: string, since: string | null = null, limit = 500) =>
  service.rpc("partner_api_export", { p_key_hash: hash(key), p_since: since, p_limit: limit });

describe("API keys", () => {
  it("are shown once, stored hashed, admin-only and limited to two live keys", async () => {
    const p = await partner();
    expect((await recruiter.client.rpc("create_partner_api_key", { p_partner_id: p, p_label: "x" })).error?.code).toBe("PT403");
    expect((await outsider.client.rpc("create_partner_api_key", { p_partner_id: p, p_label: "x" })).error?.code).toBe("PT404");

    const first = await newKey(p);
    expect(first.key).toMatch(/^nhs_pk_[0-9a-f]{64}$/);
    expect(first.key_prefix).toBe(first.key.slice(0, 15));
    const { data: stored } = await service.from("partner_api_keys").select("key_hash").eq("id", first.id).single();
    expect(stored!.key_hash).toBe(hash(first.key));
    expect((await recruiter.client.from("partner_api_keys").select("key_hash").eq("id", first.id)).error).not.toBeNull();
    expect((await recruiter.client.from("partner_api_keys").select("key_prefix, label").eq("id", first.id)).data).toEqual([
      { key_prefix: first.key_prefix, label: "ATS" },
    ]);

    await newKey(p);
    expect((await admin.client.rpc("create_partner_api_key", { p_partner_id: p, p_label: "third" })).error)
      .toMatchObject({ code: "PT400", message: expect.stringMatching(/two keys/) });

    expect((await exported(first.key)).data.status).toBe("ok");
    expect((await recruiter.client.rpc("revoke_partner_api_key", { p_key_id: first.id })).error?.code).toBe("PT403");
    expect((await admin.client.rpc("revoke_partner_api_key", { p_key_id: first.id })).error).toBeNull();
    expect((await exported(first.key)).data).toEqual({ status: "unauthorized" });
    expect((await event(first.key, { event_id: "x" })).data).toEqual({ status: "unauthorized" });
  });

  it("stop working when the partner ends, and only the service role can use them", async () => {
    const p = await partner();
    const { key } = await newKey(p);
    expect((await recruiter.client.rpc("partner_api_export", { p_key_hash: hash(key) })).error).not.toBeNull();
    const { data: row } = await service.from("partners").select("version").eq("id", p).single();
    await admin.client.rpc("update_partner", { p_partner_id: p, p_expected_version: row!.version, p_partner: { name: `Ended ${runId}-${++count}`, status: "ended" } });
    expect((await exported(key)).data).toEqual({ status: "unauthorized" });
  });
});

describe("export", () => {
  it("gives the partner its own submissions with candidate, opening and checklist, never internal terms", async () => {
    const p = await partner();
    const other = await partner();
    const mine = await submission(p, "Ana Synthetic");
    await submission(other);
    await recruiter.client.rpc("add_journey_item", { p_application_id: mine.applicationId, p_title: "BLS card", p_owner: "candidate", p_due_on: daysFromNow(10), p_note: "private note" });
    const { key } = await newKey(p);

    const { data } = await exported(key);
    expect(data.has_more).toBe(false);
    expect(data.submissions).toHaveLength(1);
    const s = data.submissions[0];
    expect(s).toMatchObject({
      submission_id: mine.id, status: "submitted", stage: "submitted",
      candidate: { full_name: "Ana Synthetic", phone: "555-0100" },
      job: { title: "Travel RN, ICU", city: "Austin", state: "TX", partner_job_reference: "REQ-77", is_strike: false },
      checklist: [{ title: "BLS card", owner: "candidate", status: "needed", due_on: daysFromNow(10) }],
    });
    const text = JSON.stringify(data);
    for (const hidden of ["9000", "hourly_rate", "internal only", "Synthetic Hospital", "private note", "stage_note"]) {
      expect(text).not.toContain(hidden);
    }

    // Paging: since the last row's updated_at returns it again, and nothing older.
    const later = await exported(key, s.updated_at, 1);
    expect(later.data.submissions.map((x: { submission_id: string }) => x.submission_id)).toEqual([mine.id]);
    expect((await exported(key, new Date(Date.now() + 60000).toISOString())).data.submissions).toEqual([]);
  });

  it("drops the candidate's details once a submission is withdrawn", async () => {
    const p = await partner();
    const s = await submission(p);
    await recruiter.client.rpc("update_partner_submission", { p_submission_id: s.id, p_expected_version: 1, p_status: "withdrawn", p_reason: "Candidate took another job" });
    const { key } = await newKey(p);
    expect((await exported(key)).data.submissions[0]).toMatchObject({ status: "withdrawn", candidate: null });
  });

  it("is available to staff in ward and logged", async () => {
    const p = await partner();
    await submission(p);
    const { data, error } = await recruiter.client.rpc("export_partner_submissions", { p_partner_id: p });
    expect(error).toBeNull();
    expect(data.submissions).toHaveLength(1);
    expect((await outsider.client.rpc("export_partner_submissions", { p_partner_id: p })).error?.code).toBe("PT404");
    const { data: audit } = await service.from("audit_events").select("actor_id, details").eq("action", "partner_export").eq("target_id", p);
    expect(audit).toEqual([{ actor_id: recruiter.id, details: { count: 1, since: null } }]);
  });
});

describe("API events", () => {
  it("move the journey, update the checklist and record the partner's reference", async () => {
    const p = await partner();
    const s = await submission(p);
    const { key } = await newKey(p);

    const first = await event(key, {
      event_id: "evt-1", submission_id: s.id, partner_candidate_reference: "ATS-123", stage: "Partner review",
      items: [{ title: "Skills checklist", status: "needed", owner: "candidate", due_on: daysFromNow(5) }],
    });
    expect(first.data).toMatchObject({
      status: "ok", result: "applied", submission_id: s.id,
      changes: { stage: { from: "submitted", to: "partner_review" }, items: 1, partner_candidate_reference: "ATS-123" },
    });

    // Later events can use the partner's own reference.
    const second = await event(key, {
      event_id: "evt-2", partner_candidate_reference: "ats-123", stage: "credentialing",
      items: [{ title: "SKILLS CHECKLIST", status: "received" }, { title: "Drug screen", status: "waived" }],
    });
    expect(second.data).toMatchObject({ result: "applied", changes: { items: 2 } });
    const { data: items } = await service.from("journey_items").select("title, status, owner, source, note, completed_at").eq("application_id", s.applicationId).order("created_at");
    expect(items).toMatchObject([
      { title: "Skills checklist", status: "received", owner: "candidate", source: "partner_update" },
      { title: "Drug screen", status: "waived", owner: "partner", note: expect.stringMatching(/^Waived by Connector Partner/) },
    ]);
    expect(items!.every((i) => i.completed_at)).toBe(true);
    const { data: app } = await service.from("job_applications").select("stage").eq("id", s.applicationId).single();
    expect(app!.stage).toBe("offered");

    // Retries are safe.
    expect((await event(key, { event_id: "evt-2", stage: "declined" })).data).toMatchObject({ result: "duplicate", original_result: "applied" });
    // An older change than the one recorded is skipped.
    expect((await event(key, { event_id: "evt-3", submission_id: s.id, stage: "interview", occurred_at: "2020-01-01T00:00:00Z" })).data)
      .toMatchObject({ result: "stale" });
    expect((await event(key, { event_id: "evt-4", submission_id: s.id, stage: "credentialing" })).data).toMatchObject({ result: "unchanged" });

    const { data: events } = await service.from("application_events").select("event_type, actor_id, details").eq("application_id", s.applicationId).in("event_type", ["journey_stage_changed", "partner_update"]).order("id");
    expect(events!.map((e) => [e.event_type, (e.details as { source: string }).source])).toEqual([
      ["journey_stage_changed", "api"], ["partner_update", "api"], ["journey_stage_changed", "api"], ["partner_update", "api"],
    ]);
  });

  it("end a journey with a default reason and need a start date to start", async () => {
    const p = await partner();
    const s = await submission(p);
    const { key } = await newKey(p);
    expect((await event(key, { event_id: "a", submission_id: s.id, stage: "started" })).data)
      .toMatchObject({ result: "rejected", error: "Give the assignment start date" });
    expect((await event(key, { event_id: "a", submission_id: s.id, stage: "started", assignment_start_on: daysFromNow(-3), assignment_end_on: daysFromNow(80) })).data)
      .toMatchObject({ result: "applied" });
    expect((await event(key, { event_id: "b", submission_id: s.id, stage: "cancelled" })).data).toMatchObject({ result: "applied" });
    const { data } = await service.from("partner_submissions").select("stage, stage_note, assignment_start_on").eq("id", s.id).single();
    expect(data).toMatchObject({ stage: "cancelled", stage_note: expect.stringMatching(/^Reported by Connector Partner/), assignment_start_on: daysFromNow(-3) });
  });

  it("are rejected, with nothing changed, when they're invalid or not the partner's", async () => {
    const p = await partner();
    const s = await submission(p);
    const theirs = await submission(await partner());
    const { key } = await newKey(p);
    const cases: [object, RegExp][] = [
      [{}, /event_id/],
      [{ event_id: "r1" }, /submission_id or partner_candidate_reference/],
      [{ event_id: "r2", submission_id: "nope" }, /isn't one of ours/],
      [{ event_id: "r3", submission_id: theirs.id, stage: "interview" }, /No submission/],
      [{ event_id: "r4", partner_candidate_reference: "unknown" }, /No open submission/],
      [{ event_id: "r5", submission_id: s.id, stage: "hired" }, /Unknown stage "hired"/],
      [{ event_id: "r6", submission_id: s.id, assignment_start_on: "12/01/2026" }, /must be a date/],
      [{ event_id: "r7", submission_id: s.id, stage: "interview", items: [{ title: "X", status: "done" }] }, /status must be/],
      [{ event_id: "r8", submission_id: s.id, items: "BLS" }, /items must be a list/],
    ];
    for (const [body, error] of cases) {
      expect((await event(key, body)).data).toMatchObject({ status: "ok", result: "rejected", error: expect.stringMatching(error) });
    }
    // r7 named a valid stage, but the whole event was undone.
    const { data } = await service.from("partner_submissions").select("stage").eq("id", s.id).single();
    expect(data!.stage).toBe("submitted");
    const { data: theirRow } = await service.from("partner_submissions").select("stage").eq("id", theirs.id).single();
    expect(theirRow!.stage).toBe("submitted");

    // Rejected events are logged without claiming their id, so a fix can reuse it.
    expect((await event(key, { event_id: "r7", submission_id: s.id, stage: "interview" })).data).toMatchObject({ result: "applied" });
    const { data: log } = await service.from("partner_events").select("event_id, result").eq("partner_id", p).order("id");
    expect(log!.filter((e) => e.result === "rejected").every((e) => e.event_id === null)).toBe(true);
    expect(log!.at(-1)).toEqual({ event_id: "r7", result: "applied" });
  });
});

describe("CSV import", () => {
  it("previews without changing anything, then applies and logs each row", async () => {
    const p = await partner();
    const a = await submission(p);
    const b = await submission(p);
    const rows = [
      { submission_id: a.id, partner_candidate_reference: "P-1", stage: "interview" },
      { partner_candidate_reference: "P-1", items: [{ title: "TB test", status: "received" }] },
      { submission_id: b.id, stage: "promoted" },
    ];

    const preview = await recruiter.client.rpc("import_partner_updates", { p_partner_id: p, p_rows: rows, p_dry_run: true });
    expect(preview.error).toBeNull();
    expect(preview.data).toMatchObject({
      dry_run: true,
      counts: { applied: 2, unchanged: 0, stale: 0, rejected: 1 },
      rows: [{ row: 1, result: "applied" }, { row: 2, result: "applied", submission_id: a.id }, { row: 3, result: "rejected" }],
    });
    const { data: still } = await service.from("partner_submissions").select("stage, partner_candidate_reference").eq("id", a.id).single();
    expect(still).toEqual({ stage: "submitted", partner_candidate_reference: null });
    expect((await service.from("partner_events").select("id").eq("partner_id", p)).data).toEqual([]);

    const applied = await recruiter.client.rpc("import_partner_updates", { p_partner_id: p, p_rows: rows, p_dry_run: false });
    expect(applied.data.counts).toEqual({ applied: 2, unchanged: 0, stale: 0, rejected: 1 });
    const { data: after } = await service.from("partner_submissions").select("stage, partner_candidate_reference").eq("id", a.id).single();
    expect(after).toEqual({ stage: "interview", partner_candidate_reference: "P-1" });
    const { data: log } = await service.from("partner_events").select("source, result, actor_id").eq("partner_id", p).order("id");
    expect(log).toEqual([
      { source: "csv", result: "applied", actor_id: recruiter.id },
      { source: "csv", result: "applied", actor_id: recruiter.id },
      { source: "csv", result: "rejected", actor_id: recruiter.id },
    ]);
    const { data: journey } = await service.from("application_events").select("actor_id, details").eq("application_id", a.applicationId).eq("event_type", "journey_stage_changed");
    expect(journey).toMatchObject([{ actor_id: recruiter.id, details: { source: "csv", to: "interview" } }]);

    // The same file again changes nothing.
    const again = await recruiter.client.rpc("import_partner_updates", { p_partner_id: p, p_rows: rows.slice(0, 2), p_dry_run: false });
    expect(again.data.counts).toEqual({ applied: 0, unchanged: 2, stale: 0, rejected: 0 });
  });

  it("is limited to the agency's own active partners and 500 rows", async () => {
    const p = await partner();
    expect((await outsider.client.rpc("import_partner_updates", { p_partner_id: p, p_rows: [{}], p_dry_run: true })).error?.code).toBe("PT404");
    expect((await recruiter.client.rpc("import_partner_updates", { p_partner_id: p, p_rows: [], p_dry_run: true })).error?.code).toBe("PT400");
    expect((await recruiter.client.rpc("import_partner_updates", { p_partner_id: p, p_rows: Array(501).fill({}), p_dry_run: true })).error?.code).toBe("PT400");
  });
});

describe("staff stage changes", () => {
  it("still work through update_journey_stage and are logged as from ward", async () => {
    const p = await partner();
    const s = await submission(p);
    expect((await recruiter.client.rpc("update_journey_stage", { p_submission_id: s.id, p_expected_version: 1, p_stage: "interview" })).error).toBeNull();
    const { data } = await service.from("application_events").select("details").eq("application_id", s.applicationId).eq("event_type", "journey_stage_changed");
    expect(data).toMatchObject([{ details: { source: "ward", from: "submitted", to: "interview" } }]);
  });
});
