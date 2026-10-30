import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

if (!url || !key) {
  throw new Error("Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (see .env.example).");
}

// PKCE keeps the sign-in code out of the URL fragment and ties it to this browser.
export const supabase = createClient(url, key, {
  auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true },
});

export type InquiryStage = "new" | "contacted" | "qualified" | "onboarding" | "placed" | "closed";
export type InquiryType = "clinician" | "facility";

export const STAGES: InquiryStage[] = ["new", "contacted", "qualified", "onboarding", "placed", "closed"];

export type InquirySummary = {
  id: string;
  inquiry_type: InquiryType;
  stage: InquiryStage;
  full_name: string;
  specialty: string | null;
  organization_name: string | null;
  preferred_location: string | null;
  assigned_recruiter_id: string | null;
  created_at: string;
};

export type Inquiry = InquirySummary & {
  organization_id: string;
  version: number;
  source: string;
  closed_reason: string | null;
  email: string;
  phone: string | null;
  timeline: string | null;
  housing_assistance_requested: boolean;
  staffing_type: string | null;
  headcount: number | null;
  desired_start_date: string | null;
  desired_end_date: string | null;
  staffing_requirements: string | null;
  consent_given_at: string;
  consent_version: string;
  follow_up_on: string | null;
  updated_at: string;
};

export type InquiryEvent = {
  id: number;
  event_type: string;
  from_stage: InquiryStage | null;
  to_stage: InquiryStage | null;
  actor_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
};

export type InquiryNote = {
  id: string;
  author_id: string | null;
  body: string;
  created_at: string;
};

export type StaffMember = {
  user_id: string;
  full_name: string | null;
  role: "admin" | "recruiter";
};

// Staff functions raise PostgREST PTxxx codes (see the staff_pipeline and
// jobs migrations). PT400 messages are written to be shown as-is.
export function pipelineError(error: { code?: string; message: string }, thing = "inquiry"): string {
  if (error.code === "PT400") return error.message;
  if (error.code === "PT409") return `Someone else changed this ${thing}. The page now shows the latest version; check it and try again.`;
  if (error.code === "PT404") return `This ${thing} no longer exists, or you've lost access to it.`;
  return "Couldn't save. Check your connection and try again.";
}

export type Membership = {
  organization_id: string;
  role: "admin" | "recruiter";
  organizations: { name: string } | null;
};

// --- Jobs ----------------------------------------------------------------------

export type JobStatus = "draft" | "open" | "on_hold" | "filled" | "closed";
export const JOB_STATUSES: JobStatus[] = ["draft", "open", "on_hold", "filled", "closed"];
export const EMPLOYMENT_TYPES = ["travel", "local_contract", "per_diem", "permanent"] as const;
export const SHIFTS = ["day", "evening", "night", "rotating", "variable"] as const;
export const JOB_SOURCES = ["direct_contract", "vms", "other"] as const;

// Fields that appear on the public job board once the job is open.
export type JobPublic = {
  title: string;
  specialty: string;
  employment_type: (typeof EMPLOYMENT_TYPES)[number];
  city: string;
  state: string;
  shift: (typeof SHIFTS)[number] | null;
  hours_per_week: number | null;
  start_date: string | null;
  duration_weeks: number | null;
  openings: number;
  public_description: string | null;
};

// Staff-only fields, stored in job_internal_details and never published.
export type JobInternal = {
  facility_name: string;
  facility_contact: string | null;
  source: (typeof JOB_SOURCES)[number];
  requisition_reference: string | null;
  rate_notes: string | null;
  internal_notes: string | null;
};

export type Job = JobPublic & {
  id: string;
  organization_id: string;
  status: JobStatus;
  published_at: string | null;
  version: number;
  created_at: string;
};

export type JobEvent = {
  id: number;
  event_type: string;
  from_status: JobStatus | null;
  to_status: JobStatus | null;
  actor_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
};

export type ApplicationStage = "applied" | "screening" | "submitted" | "offered" | "hired" | "rejected" | "withdrawn";
export const APPLICATION_STAGES: ApplicationStage[] = ["applied", "screening", "submitted", "offered", "hired", "rejected", "withdrawn"];
export const STAGES_WITH_REASON: ApplicationStage[] = ["rejected", "withdrawn"];

export type JobApplication = {
  id: string;
  job_id: string;
  inquiry_id: string | null;
  source: "website" | "recruiter" | "portal";
  stage: ApplicationStage;
  stage_reason: string | null;
  full_name: string;
  email: string;
  phone: string | null;
  version: number;
  created_at: string;
};
