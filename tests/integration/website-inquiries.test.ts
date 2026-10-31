// Website inquiries that carry a job and a referral code: an inquiry about an
// advertised, open job is also an application on it, and the code is kept on
// both. Jobs the public can't see are ignored.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { addMember, createOrganization, createUser, inquiryPayload, service, submit } from "./setup.ts";

type User = { id: string; client: SupabaseClient };

let org: { id: string; slug: string };
let other: { id: string; slug: string };
let recruiter: User;

beforeAll(async () => {
  org = await createOrganization("web-inq");
  other = await createOrganization("web-inq-other");
  recruiter = await createUser("web-inq-recruiter");
  await addMember(org.id, recruiter.id, "admin");
});

async function job(status: "draft" | "open" | "closed" = "open", orgId = org.id, client = recruiter.client) {
  const created = await client.rpc("create_job", {
    p_organization_id: orgId,
    p_job: { title: "Travel RN, ICU", specialty: "ICU", employment_type: "travel", city: "Austin", state: "TX", openings: 1 },
    p_internal: { facility_name: "Synthetic Hospital" },
  });
  if (created.error) throw created.error;
  let version = created.data.version as number;
  for (const next of status === "draft" ? [] : status === "open" ? ["open"] : ["open", "closed"]) {
    const set = await client.rpc("set_job_status", { p_job_id: created.data.id, p_expected_version: version, p_status: next });
    if (set.error) throw set.error;
    version = set.data.version;
  }
  return created.data.id as string;
}

const inquiry = async (id: string) =>
  (await service.from("inquiries").select("job_id, referral_code").eq("id", id).single()).data;
const applications = async (jobId: string) =>
  (await service.from("job_applications").select("id, inquiry_id, source, email, consent_version, referral_code").eq("job_id", jobId)).data!;
const outbox = async (column: string, id: string) =>
  (await service.from("notification_outbox").select("template").eq(column, id).order("template")).data!.map((r) => r.template);

describe("an inquiry about an open job", () => {
  it("becomes an application on that job, with one confirmation, and keeps the referral code", async () => {
    const jobId = await job();
    const body = inquiryPayload({ job_id: jobId, referral_code: "FRIEND42" });
    const result = await submit(org.slug, body);
    expect(result).toMatchObject({ status: "created", inquiry_id: expect.any(String), application_id: expect.any(String) });

    expect(await inquiry(result.inquiry_id!)).toEqual({ job_id: jobId, referral_code: "FRIEND42" });
    expect(await applications(jobId)).toEqual([{
      id: result.application_id, inquiry_id: result.inquiry_id, source: "website",
      email: body.email, consent_version: body.consent_version, referral_code: "FRIEND42",
    }]);
    // The job's confirmation replaces the inquiry's, so they get one email.
    expect(await outbox("inquiry_id", result.inquiry_id!)).toEqual([]);
    expect(await outbox("application_id", result.application_id!))
      .toEqual(["job_application_confirmation", "staff_new_application_alert"]);

    // A retry returns the same inquiry and application.
    expect(await submit(org.slug, body)).toEqual({ ...result, status: "duplicate" });
  });

  it("links to an existing application rather than creating another", async () => {
    const jobId = await job();
    const first = await submit(org.slug, inquiryPayload({ job_id: jobId }));
    const again = await submit(org.slug, inquiryPayload({ job_id: jobId, email: (await applications(jobId))[0].email, timeline: "exploring" }));
    expect(again.status).toBe("created");
    expect(again.application_id).toBe(first.application_id);
    expect(await applications(jobId)).toHaveLength(1);
    expect(await outbox("inquiry_id", again.inquiry_id!)).toEqual(["clinician_inquiry_confirmation", "staff_new_inquiry_alert"]);
  });

  it("counts inquiries about different jobs as different inquiries", async () => {
    const [a, b] = [await job(), await job()];
    const body = inquiryPayload();
    const one = await submit(org.slug, { ...body, job_id: a });
    const two = await submit(org.slug, { ...body, job_id: b });
    expect(two.status).toBe("created");
    expect(two.inquiry_id).not.toBe(one.inquiry_id);
  });
});

describe("an inquiry about a job that can't take it", () => {
  it("remembers a closed job but applies no one", async () => {
    const jobId = await job("closed");
    const result = await submit(org.slug, inquiryPayload({ job_id: jobId }));
    expect(result).not.toHaveProperty("application_id");
    expect(await inquiry(result.inquiry_id!)).toEqual({ job_id: jobId, referral_code: null });
    expect(await applications(jobId)).toEqual([]);
    expect(await outbox("inquiry_id", result.inquiry_id!)).toEqual(["clinician_inquiry_confirmation", "staff_new_inquiry_alert"]);
  });

  it("ignores drafts, another agency's jobs, unknown ids and facility inquiries", async () => {
    const otherAdmin = await createUser("web-inq-other-admin");
    await addMember(other.id, otherAdmin.id, "admin");
    const draft = await job("draft");
    const elsewhere = await job("open", other.id, otherAdmin.client);
    const open = await job();

    for (const [jobId, extra] of [
      [draft, {}], [elsewhere, {}], ["00000000-0000-4000-8000-000000000000", {}], ["not-a-uuid", {}],
      [open, { inquiry_type: "facility", organization_name: "Example Hospital" }],
    ] as [string, Record<string, unknown>][]) {
      const result = await submit(org.slug, inquiryPayload({ job_id: jobId, ...extra }));
      expect(result.status).toBe("created");
      expect(result).not.toHaveProperty("application_id");
      expect((await inquiry(result.inquiry_id!))!.job_id).toBeNull();
    }
    expect(await applications(open)).toEqual([]);
    expect(await applications(elsewhere)).toEqual([]);
  });

  it("drops a referral code in the wrong shape rather than failing", async () => {
    const result = await submit(org.slug, inquiryPayload({ referral_code: "not valid!" }));
    expect(result.status).toBe("created");
    expect(await inquiry(result.inquiry_id!)).toEqual({ job_id: null, referral_code: null });
  });
});

describe("staff", () => {
  it("see the job and referral code on the inquiry", async () => {
    const jobId = await job();
    const { inquiry_id } = await submit(org.slug, inquiryPayload({ job_id: jobId, referral_code: "NURSE-7" }));
    const { data } = await recruiter.client.from("inquiries").select("referral_code, job:jobs(title)").eq("id", inquiry_id!).single();
    expect(data).toEqual({ referral_code: "NURSE-7", job: { title: "Travel RN, ICU" } });
  });
});
