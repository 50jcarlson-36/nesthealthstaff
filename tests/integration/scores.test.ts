// Opportunity score and matching openings. Each test uses its own agency, so
// the medians it compares against are known.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { addMember, createOrganization, createUser, inquiryPayload, service, submit } from "./setup.ts";

type User = { id: string; client: SupabaseClient };
type Score = {
  job_id: string; score: number; need_score: number; pay_score: number; incentive_score: number;
  effective_weekly_cents: number | null; median_weekly_cents: number | null; pay_vs_median_pct: number | null;
  need_reasons: string[]; pay_reason: string; incentive_reasons: string[]; suggestion: string | null; is_strike: boolean;
};

let n = 0;
const daysFromNow = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

async function agency() {
  const org = await createOrganization(`scores-${++n}`);
  const recruiter: User = await createUser(`scores-${n}`);
  await addMember(org.id, recruiter.id, "admin");
  const { data: partner } = await recruiter.client.rpc("create_partner", {
    p_organization_id: org.id,
    p_partner: { name: `Score Partner ${n}`, status: "active", agreement_signed_on: "2026-10-01", attribution_days: 90 },
  });
  return { org, recruiter, partnerId: partner.id as string };
}

type Agency = Awaited<ReturnType<typeof agency>>;

async function openJob(a: Agency, job: Record<string, unknown>, terms: Record<string, unknown> = {}) {
  const created = await a.recruiter.client.rpc("create_job", {
    p_organization_id: a.org.id,
    p_job: { title: "Travel RN", specialty: "ICU", employment_type: "travel", city: "Austin", state: "TX", start_date: daysFromNow(60), duration_weeks: 13, openings: 1, ...job },
    p_internal: { facility_name: "Synthetic Hospital" },
  });
  if (created.error) throw created.error;
  const opened = await a.recruiter.client.rpc("set_job_status", { p_job_id: created.data.id, p_expected_version: created.data.version, p_status: "open" });
  if (Object.keys(terms).length) {
    const set = await a.recruiter.client.rpc("set_job_terms", { p_job_id: created.data.id, p_expected_version: opened.data.version, p_terms: { partner_id: a.partnerId, ...terms } });
    if (set.error) throw set.error;
  }
  return created.data.id as string;
}

async function score(a: Agency, jobId: string): Promise<Score> {
  const { data } = await a.recruiter.client.from("opportunity_scores").select("*").eq("job_id", jobId).single();
  return data as Score;
}

describe("opportunity score", () => {
  let a: Agency;
  beforeAll(async () => { a = await agency(); });

  it("compares pay with the specialty median, spreading bonuses over the assignment", async () => {
    const low = await openJob(a, {}, { weekly_gross_cents: 200000 });
    const mid = await openJob(a, {}, { weekly_gross_cents: 250000 });
    // $2,600 a week plus $1,300 of bonuses over 13 weeks = $2,700.
    const high = await openJob(a, {}, { weekly_gross_cents: 260000, sign_on_bonus_cents: 100000, nest_incentive_cents: 30000 });

    expect(await score(a, mid)).toMatchObject({ effective_weekly_cents: 250000, median_weekly_cents: 250000, pay_score: 20, pay_vs_median_pct: 0, pay_reason: "0% above the specialty median" });
    expect(await score(a, high)).toMatchObject({ effective_weekly_cents: 270000, pay_score: 28, pay_vs_median_pct: 8, incentive_score: 13, incentive_reasons: ["Nest incentive", "Sign-on bonus"] });
    expect(await score(a, low)).toMatchObject({ pay_score: 0, pay_vs_median_pct: -20, pay_reason: "20% below the specialty median" });
  });

  it("builds the package from the hourly rate when there's no weekly gross", async () => {
    const id = await openJob(a, { specialty: "Med-Surg", hours_per_week: 40 }, { hourly_rate_cents: 5000, housing_stipend_weekly_cents: 70000 });
    expect(await score(a, id)).toMatchObject({ effective_weekly_cents: 270000, median_weekly_cents: expect.any(Number), pay_reason: expect.stringMatching(/agency median/) });
  });

  it("rates need from priority, crisis rate, start date and unfilled openings, and suggests an incentive", async () => {
    const urgent = await openJob(a, { start_date: daysFromNow(10), openings: 3 }, { priority: "critical", is_crisis_rate: true, weekly_gross_cents: 200000 });
    const s = await score(a, urgent);
    expect(s.need_score).toBe(40);
    expect(s.need_reasons).toEqual(["Partner marked it critical", "Crisis rate", "Starts within 2 weeks", "3 openings unfilled", "No candidates in play yet"]);
    expect(s.suggestion).toMatch(/below-median pay: consider a Nest incentive/);
    expect(s.score).toBe(s.need_score + s.pay_score + s.incentive_score);

    const unpriced = await openJob(a, { start_date: daysFromNow(10) }, { priority: "critical" });
    expect(await score(a, unpriced)).toMatchObject({ pay_score: 0, pay_reason: "No pay on file", suggestion: expect.stringMatching(/add the pay package/) });
  });

  it("doesn't score strike work higher, and leaves out jobs that aren't open", async () => {
    const plain = await openJob(a, { specialty: "PACU" }, { weekly_gross_cents: 250000 });
    const strike = await openJob(a, { specialty: "PACU" }, { weekly_gross_cents: 250000, is_strike: true });
    const [p, s] = [await score(a, plain), await score(a, strike)];
    expect(s.is_strike).toBe(true);
    expect(s.score).toBe(p.score);

    const draft = await a.recruiter.client.rpc("create_job", {
      p_organization_id: a.org.id,
      p_job: { title: "Draft", specialty: "ICU", employment_type: "travel", city: "Austin", state: "TX", openings: 1 },
      p_internal: { facility_name: "Synthetic Hospital" },
    });
    expect((await a.recruiter.client.from("opportunity_scores").select("job_id").eq("job_id", draft.data.id)).data).toEqual([]);
  });

  it("is visible to the agency's own staff only", async () => {
    const other = await agency();
    const id = await openJob(a, {}, { weekly_gross_cents: 250000 });
    expect((await other.recruiter.client.from("opportunity_scores").select("job_id").eq("job_id", id)).data).toEqual([]);
  });
});

describe("matching openings", () => {
  it("rank by fit and opportunity, explain the fit, and sort by pay for wage options", async () => {
    const a = await agency();
    const austinIcu = await openJob(a, { title: "ICU Austin", start_date: daysFromNow(20) }, { weekly_gross_cents: 250000, housing_stipend_weekly_cents: 80000 });
    const dallasIcu = await openJob(a, { title: "ICU Dallas", city: "Dallas", start_date: daysFromNow(20) }, { weekly_gross_cents: 300000, is_strike: true });
    const denverTele = await openJob(a, { title: "Tele Denver", specialty: "Telemetry", city: "Denver", state: "CO", start_date: daysFromNow(150) }, { weekly_gross_cents: 280000 });

    const slug = (await service.from("organizations").select("slug").eq("id", a.org.id).single()).data!.slug;
    const { inquiry_id } = await submit(slug,
      inquiryPayload({ specialty: "icu", preferred_location: "Austin, TX", timeline: "asap", housing_assistance_requested: true }));

    const { data, error } = await a.recruiter.client.rpc("matching_openings", { p_inquiry_id: inquiry_id });
    expect(error).toBeNull();
    const byId = new Map((data as { job_id: string; fit_score: number; fit_reasons: string[]; rank: number; is_strike: boolean }[]).map((m) => [m.job_id, m]));
    expect(byId.get(austinIcu)).toMatchObject({
      fit_score: 100, fit_reasons: ["Same specialty", "In their preferred city", "Start date fits their timing", "Wants housing help; housing stipend offered"],
    });
    expect(byId.get(dallasIcu)).toMatchObject({
      fit_score: 90, is_strike: true, fit_reasons: ["Same specialty", "In their preferred state", "Start date fits their timing", "Wants housing help; no housing stipend on file"],
    });
    expect(byId.get(denverTele)).toMatchObject({ fit_score: 10, fit_reasons: expect.arrayContaining(["Different specialty", "Outside their preferred location", "Start date doesn't fit their timing"]) });
    // Rank is 60% fit and 40% opportunity; the strike job's higher pay can
    // lift it, but nothing about the strike itself does.
    const rows = data as { job_id: string; fit_score: number; opportunity_score: number; rank: number }[];
    for (const m of rows) expect(m.rank).toBe(Math.round(0.6 * m.fit_score + 0.4 * m.opportunity_score));
    expect(rows.map((m) => m.rank)).toEqual([...rows.map((m) => m.rank)].sort((x, y) => y - x));

    // Another agency sees nothing for this inquiry.
    const other = await agency();
    expect((await other.recruiter.client.rpc("matching_openings", { p_inquiry_id: inquiry_id })).data).toEqual([]);
  });

  it("treat an open location and a related specialty fairly", async () => {
    const a = await agency();
    const job = await openJob(a, { specialty: "Cardiac ICU", city: "Tulsa", state: "OK", start_date: null }, { weekly_gross_cents: 250000 });
    const slug = (await service.from("organizations").select("slug").eq("id", a.org.id).single()).data!.slug;
    const { inquiry_id } = await submit(slug, inquiryPayload({ specialty: "ICU", preferred_location: "Anywhere in the south", timeline: "exploring" }));
    const { data } = await a.recruiter.client.rpc("matching_openings", { p_inquiry_id: inquiry_id });
    expect(data).toEqual([expect.objectContaining({ job_id: job, fit_score: 30 + 20 + 8 + 5, fit_reasons: ["Related specialty", "Open to anywhere"] })]);
  });
});
