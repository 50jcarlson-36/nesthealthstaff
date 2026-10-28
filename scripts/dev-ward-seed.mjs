// Seeds the LOCAL stack for trying the ward portal: a recruiter account on the
// synthetic dev organization and a few synthetic inquiries. Refuses to run
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

// Recruiter account. No password: sign-in is by magic link only.
const { data: list } = await service.auth.admin.listUsers();
let user = list.users.find((u) => u.email === RECRUITER_EMAIL);
if (!user) {
  const { data, error } = await service.auth.admin.createUser({ email: RECRUITER_EMAIL, email_confirm: true, user_metadata: { full_name: "Dev Recruiter" } });
  if (error) throw error;
  user = data.user;
}
const { error: memberError } = await service
  .from("organization_memberships")
  .upsert({ organization_id: org.id, user_id: user.id, role: "recruiter" }, { onConflict: "organization_id,user_id", ignoreDuplicates: true });
if (memberError) throw memberError;

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

console.log(`Recruiter ${RECRUITER_EMAIL} is a member of ${ORG_SLUG}; ${created} new synthetic inquiries.`);
