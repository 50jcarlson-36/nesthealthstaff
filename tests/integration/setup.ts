// Connection details for the LOCAL Supabase stack, read from `supabase status`.
// Integration tests create synthetic users and organizations; they refuse to run
// against anything other than a loopback API URL.

import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function readStatus(): Record<string, string> {
  const output = execFileSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8" });
  const values: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const match = line.match(/^([A-Z_]+)="?(.*?)"?$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

const status = readStatus();
export const API_URL = status.API_URL;
export const ANON_KEY = status.ANON_KEY;
export const SERVICE_ROLE_KEY = status.SERVICE_ROLE_KEY;

if (!API_URL || !/^http:\/\/(127\.0\.0\.1|localhost):/.test(API_URL)) {
  throw new Error(`Integration tests only run against a local stack; got API_URL=${API_URL}`);
}

const options = { auth: { persistSession: false, autoRefreshToken: false } };

export const service = createClient(API_URL, SERVICE_ROLE_KEY, options);
export const anon = (): SupabaseClient => createClient(API_URL, ANON_KEY, options);

// Unique suffix so repeated runs don't collide.
export const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export async function createOrganization(label: string, alertEmail: string | null = `alerts-${label}@example.com`) {
  const { data, error } = await service
    .from("organizations")
    .insert({ slug: `test-${label}-${runId}`, name: `Test ${label}`, intake_notification_email: alertEmail })
    .select()
    .single();
  if (error) throw error;
  return data as { id: string; slug: string };
}

// Test-only password generated per run, never reused outside the local stack.
const password = `local-test-${runId}-Aa1!`;

export async function createUser(label: string): Promise<{ id: string; client: SupabaseClient }> {
  const email = `${label}-${runId}@example.com`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const client = anon();
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;
  return { id: data.user!.id, client };
}

export async function addMember(organizationId: string, userId: string, role: "admin" | "recruiter") {
  const { error } = await service
    .from("organization_memberships")
    .insert({ organization_id: organizationId, user_id: userId, role });
  if (error) throw error;
}

let counter = 0;
export function inquiryPayload(overrides: Record<string, unknown> = {}) {
  counter++;
  return {
    inquiry_type: "clinician",
    full_name: "Test Clinician",
    email: `clinician-${runId}-${counter}@example.com`,
    phone: null,
    specialty: "Telemetry",
    preferred_location: "Denver, CO",
    timeline: "asap",
    housing_assistance_requested: false,
    organization_name: null,
    staffing_type: null,
    headcount: null,
    desired_start_date: null,
    desired_end_date: null,
    staffing_requirements: null,
    consent_version: "test",
    ...overrides,
  };
}

export async function submit(slug: string, inquiry: Record<string, unknown>, key: string | null = null, clientHash: string | null = null) {
  const { data, error } = await service.rpc("submit_inquiry", {
    p_organization_slug: slug,
    p_inquiry: inquiry,
    p_idempotency_key: key,
    p_client_hash: clientHash,
  });
  if (error) throw error;
  return data as { status: "created" | "duplicate" | "rate_limited"; inquiry_id?: string };
}
