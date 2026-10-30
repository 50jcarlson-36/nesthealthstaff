// Seeds the LOCAL stack for trying the ward portal: a recruiter and an admin on
// the synthetic dev organization, a few synthetic inquiries, and two synthetic
// jobs (one open with a website application, one draft). Refuses to run
// against anything but a loopback Supabase URL.
//
//   node scripts/dev-ward-seed.mjs
//
// Then sign in at http://127.0.0.1:3003 as recruiter@example.com and open the
// magic link from Mailpit (http://127.0.0.1:55324).

import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const status = JSON.parse(execFileSync("npx", ["supabase", "status", "-o", "json"], { encoding: "utf8" }));
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(status.API_URL)) {
  throw new Error(`Only runs against a local stack; got ${status.API_URL}`);
}

const ORG_SLUG = "nest-health-staff-dev";
const RECRUITER_EMAIL = "recruiter@example.com";
const service = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: org, error: orgError } = await service.from("organizations").select("id").eq("slug", ORG_SLUG).single();
if (orgError) throw orgError;

// Staff accounts. No passwords: sign-in is by magic link only.
const STAFF = [
  { email: RECRUITER_EMAIL, full_name: "Dev Recruiter", role: "recruiter" },
  { email: "admin@example.com", full_name: "Dev Admin", role: "admin" },
];
// Integration tests leave many users behind, so page through all of them.
const users = [];
for (let page = 1; ; page++) {
  const { data, error } = await service.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) throw error;
  users.push(...data.users);
  if (data.users.length < 1000) break;
}
for (const member of STAFF) {
  let user = users.find((u) => u.email === member.email);
  if (!user) {
    const { data, error } = await service.auth.admin.createUser({ email: member.email, email_confirm: true, user_metadata: { full_name: member.full_name } });
    if (error) throw error;
    user = data.user;
  }
  const { error } = await service
    .from("organization_memberships")
    .upsert({ organization_id: org.id, user_id: user.id, role: member.role }, { onConflict: "organization_id,user_id", ignoreDuplicates: true });
  if (error) throw error;
}

const base = {
  phone: null, specialty: null, preferred_location: null, timeline: null, housing_assistance_requested: false,
  organization_name: null, staffing_type: null, headcount: null, desired_start_date: null, desired_end_date: null,
  staffing_requirements: null, consent_version: "dev-seed",
};
const inquiries = [
  { inquiry_type: "clinician", full_name: "Avery Example", email: "avery@example.com", phone: "555-0100", specialty: "ICU", preferred_location: "Denver, CO", timeline: "asap", housing_assistance_requested: true },
  { inquiry_type: "clinician", full_name: "Jordan Sample", email: "jordan@example.com", specialty: "Labor & Delivery", preferred_location: "Phoenix, AZ", timeline: "within_1_3_months" },
  { inquiry_type: "facility", full_name: "Riley Placeholder", email: "riley@example.com", organization_name: "Example Regional Medical Center", preferred_location: "Boise, ID", staffing_type: "Travel contracts", headcount: 4, desired_start_date: "2026-12-01", desired_end_date: "2027-03-01", staffing_requirements: "Night-shift telemetry RNs, 13-week contracts." },
];

let created = 0;
for (const inquiry of inquiries) {
  const { data, error } = await service.rpc("submit_inquiry", {
    p_organization_slug: ORG_SLUG,
    p_inquiry: { ...base, ...inquiry },
    p_idempotency_key: `dev-ward-seed-${inquiry.email}`,
    p_client_hash: null,
  });
  if (error) throw error;
  if (data.status === "created") created++;
}

// Jobs. Staff create jobs through create_job in ward; the seed has no signed-in
// user, so it writes the rows directly with the service role. Every value is
// made up, including the facility and the rate note.
const JOBS = [
  {
    job: { status: "open", published_at: new Date().toISOString(), title: "Travel RN, Telemetry (nights)", specialty: "Telemetry", employment_type: "travel", city: "Boise", state: "ID", shift: "night", hours_per_week: 36, start_date: "2026-12-07", duration_weeks: 13, openings: 2, public_description: "Synthetic dev job. Not a real opening." },
    internal: { facility_name: "Example Regional Medical Center", facility_contact: "Unit manager (synthetic)", source: "direct_contract", requisition_reference: "DEV-001", rate_notes: "Synthetic placeholder, not a real rate." },
    applicant: { full_name: "Casey Applicant", email: "casey@example.com", phone: null, consent_version: "dev-seed" },
  },
  {
    job: { status: "draft", title: "Local contract RN, Labor & Delivery", specialty: "Labor & Delivery", employment_type: "local_contract", city: "Phoenix", state: "AZ", shift: "day", openings: 1, public_description: "Synthetic dev job. Not a real opening." },
    internal: { facility_name: "Sample Community Hospital", source: "direct_contract", requisition_reference: "DEV-002" },
  },
];

let jobsCreated = 0;
for (const { job, internal, applicant } of JOBS) {
  const { data: existing } = await service.from("job_internal_details").select("job_id").eq("organization_id", org.id).eq("requisition_reference", internal.requisition_reference).maybeSingle();
  if (existing) continue;
  const { data: row, error } = await service.from("jobs").insert({ ...job, organization_id: org.id }).select("id").single();
  if (error) throw error;
  const { error: internalError } = await service.from("job_internal_details").insert({ ...internal, job_id: row.id, organization_id: org.id });
  if (internalError) throw internalError;
  const events = [{ event_type: "created", to_status: "draft" }];
  if (job.status !== "draft") events.push({ event_type: "status_changed", from_status: "draft", to_status: job.status });
  const { error: eventError } = await service.from("job_events").insert(events.map((e) => ({ ...e, job_id: row.id, organization_id: org.id, details: { source: "dev-seed" } })));
  if (eventError) throw eventError;
  if (applicant) {
    const { error: applyError } = await service.rpc("submit_job_application", { p_organization_slug: ORG_SLUG, p_job_id: row.id, p_application: applicant });
    if (applyError) throw applyError;
  }
  jobsCreated++;
}

console.log(`${STAFF.map((m) => m.email).join(" and ")} are staff of ${ORG_SLUG}; ${created} new synthetic inquiries; ${jobsCreated} new synthetic jobs.`);
