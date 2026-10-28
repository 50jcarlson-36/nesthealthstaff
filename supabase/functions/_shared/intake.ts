// Validation and normalization for public intake submissions.
//
// Accepts the payload the live website already sends to /api/leads:
//   { name, email, phone, specialty, location, timeline, organization,
//     website (honeypot), consent: boolean, type: "nurse" | "employer" }
// plus optional facility and housing fields from the intake specification.
// Pure TypeScript with no runtime imports, so Deno and Vitest share it.

export const CONSENT_VERSION = "2026-10-website-v1";

// Labels shown by the live form, mapped to stored codes. Codes are accepted too.
const TIMELINES: Record<string, string> = {
  "as soon as possible": "asap",
  "within 1–3 months": "within_1_3_months",
  "within 1-3 months": "within_1_3_months",
  "within 3–6 months": "within_3_6_months",
  "within 3-6 months": "within_3_6_months",
  "just exploring": "exploring",
  asap: "asap",
  within_1_3_months: "within_1_3_months",
  within_3_6_months: "within_3_6_months",
  exploring: "exploring",
};

const INQUIRY_TYPES: Record<string, "clinician" | "facility"> = {
  nurse: "clinician",
  clinician: "clinician",
  employer: "facility",
  facility: "facility",
};

export type NormalizedInquiry = {
  inquiry_type: "clinician" | "facility";
  full_name: string;
  email: string;
  phone: string | null;
  specialty: string | null;
  preferred_location: string | null;
  timeline: string | null;
  housing_assistance_requested: boolean;
  organization_name: string | null;
  staffing_type: string | null;
  headcount: number | null;
  desired_start_date: string | null;
  desired_end_date: string | null;
  staffing_requirements: string | null;
  consent_version: string;
};

export type ParseResult =
  | { kind: "valid"; inquiry: NormalizedInquiry }
  | { kind: "honeypot" }
  | { kind: "invalid"; error: string };

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

class InvalidField extends Error {}

function text(
  body: Record<string, unknown>,
  keys: string[],
  max: number,
  label: string,
): string | null {
  for (const key of keys) {
    const value = body[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") throw new InvalidField(`${label} must be text.`);
    // Collapse whitespace and strip control characters.
    const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    if (cleaned === "") continue;
    if (cleaned.length > max) {
      throw new InvalidField(`${label} must be ${max} characters or fewer.`);
    }
    return cleaned;
  }
  return null;
}

function date(body: Record<string, unknown>, key: string, label: string): string | null {
  const value = text(body, [key], 10, label);
  if (value === null) return null;
  if (!DATE_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new InvalidField(`${label} must be a date (YYYY-MM-DD).`);
  }
  return value;
}

function flag(value: unknown): boolean {
  return value === true || value === "true" || value === "on" || value === "yes";
}

export function parseIntake(raw: unknown): ParseResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { kind: "invalid", error: "Please complete the form and try again." };
  }
  const body = raw as Record<string, unknown>;

  // Bots fill the hidden "website" field. Callers report success without saving.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return { kind: "honeypot" };
  }

  try {
    const inquiryType = INQUIRY_TYPES[String(body.type ?? "").toLowerCase()];
    if (!inquiryType) throw new InvalidField("Please choose nurse or employer.");

    const fullName = text(body, ["name", "full_name"], 160, "Name");
    if (!fullName || fullName.length < 2) throw new InvalidField("Please enter your name.");

    const email = text(body, ["email"], 254, "Email")?.toLowerCase() ?? null;
    if (!email || !EMAIL_PATTERN.test(email)) {
      throw new InvalidField("Please enter a valid email address.");
    }

    if (!flag(body.consent)) {
      throw new InvalidField("Please agree to be contacted so we can follow up.");
    }

    const timelineInput = text(body, ["timeline"], 40, "Timing");
    const timeline = timelineInput === null ? null : TIMELINES[timelineInput.toLowerCase()];
    if (timeline === undefined) throw new InvalidField("Please choose a start timing from the list.");

    const organizationName = text(body, ["organization", "organization_name"], 200, "Organization");
    if (inquiryType === "facility" && !organizationName) {
      throw new InvalidField("Please enter your organization's name.");
    }

    let headcount: number | null = null;
    if (body.headcount !== undefined && body.headcount !== null && body.headcount !== "") {
      headcount = Number(body.headcount);
      if (!Number.isInteger(headcount) || headcount < 1 || headcount > 1000) {
        throw new InvalidField("Headcount must be a whole number between 1 and 1000.");
      }
    }

    const desiredStart = date(body, "desired_start_date", "Start date");
    const desiredEnd = date(body, "desired_end_date", "End date");
    if (desiredStart && desiredEnd && desiredEnd < desiredStart) {
      throw new InvalidField("End date must be on or after the start date.");
    }

    return {
      kind: "valid",
      inquiry: {
        inquiry_type: inquiryType,
        full_name: fullName,
        email,
        phone: text(body, ["phone"], 40, "Phone"),
        specialty: text(body, ["specialty"], 80, "Specialty"),
        preferred_location: text(body, ["location", "preferred_location"], 160, "Location"),
        timeline,
        housing_assistance_requested: flag(body.housing_assistance_requested),
        organization_name: inquiryType === "facility" ? organizationName : null,
        staffing_type: text(body, ["staffing_type"], 80, "Staffing type"),
        headcount,
        desired_start_date: desiredStart,
        desired_end_date: desiredEnd,
        staffing_requirements: text(body, ["staffing_requirements"], 2000, "Staffing requirements"),
        consent_version: CONSENT_VERSION,
      },
    };
  } catch (error) {
    if (error instanceof InvalidField) return { kind: "invalid", error: error.message };
    throw error;
  }
}

// Keys must be printable and bounded; anything else is ignored rather than rejected.
export function normalizeIdempotencyKey(value: string | null): string | null {
  if (!value) return null;
  const key = value.trim();
  return /^[\x21-\x7e]{8,200}$/.test(key) ? key : null;
}
