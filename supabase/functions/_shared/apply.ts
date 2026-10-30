// Validation and normalization for public job applications.
//
// Request body:
//   { job_id, name (or full_name), email, phone?, consent: boolean,
//     website (honeypot) }
// Applications collect contact details only: no résumé, licence number or
// free text, so nothing health-related can be typed in.
// Pure TypeScript with no runtime imports, so Deno and Vitest share it.

export const APPLICATION_CONSENT_VERSION = "2026-10-apply-v1";

export type NormalizedApplication = {
  job_id: string;
  full_name: string;
  email: string;
  phone: string | null;
  consent_version: string;
};

export type ApplicationParseResult =
  | { kind: "valid"; application: NormalizedApplication }
  | { kind: "honeypot" }
  | { kind: "invalid"; error: string };

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class InvalidField extends Error {}

function text(body: Record<string, unknown>, keys: string[], max: number, label: string): string | null {
  for (const key of keys) {
    const value = body[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") throw new InvalidField(`${label} must be text.`);
    // Collapse whitespace and strip control characters.
    const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    if (cleaned === "") continue;
    if (cleaned.length > max) throw new InvalidField(`${label} must be ${max} characters or fewer.`);
    return cleaned;
  }
  return null;
}

export function parseApplication(raw: unknown): ApplicationParseResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { kind: "invalid", error: "Please complete the form and try again." };
  }
  const body = raw as Record<string, unknown>;

  // Bots fill the hidden "website" field. Callers report success without saving.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return { kind: "honeypot" };
  }

  try {
    const jobId = typeof body.job_id === "string" ? body.job_id.trim().toLowerCase() : "";
    if (!UUID_PATTERN.test(jobId)) throw new InvalidField("We couldn't find that job. Please go back to the job list.");

    const fullName = text(body, ["name", "full_name"], 160, "Name");
    if (!fullName || fullName.length < 2) throw new InvalidField("Please enter your name.");

    const email = text(body, ["email"], 254, "Email")?.toLowerCase() ?? null;
    if (!email || !EMAIL_PATTERN.test(email)) throw new InvalidField("Please enter a valid email address.");

    if (body.consent !== true && body.consent !== "true" && body.consent !== "on" && body.consent !== "yes") {
      throw new InvalidField("Please agree to be contacted about this job.");
    }

    return {
      kind: "valid",
      application: {
        job_id: jobId,
        full_name: fullName,
        email,
        phone: text(body, ["phone"], 40, "Phone"),
        consent_version: APPLICATION_CONSENT_VERSION,
      },
    };
  } catch (error) {
    if (error instanceof InvalidField) return { kind: "invalid", error: error.message };
    throw error;
  }
}
