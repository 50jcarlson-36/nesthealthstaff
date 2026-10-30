// Validation for staff invitations sent from ward to the staff-invite function.
// The database checks everything again; this keeps bad requests away from it
// and gives the admin a message they can act on.

export type StaffRole = "admin" | "recruiter";

export type StaffInvite = {
  organization_id: string;
  email: string;
  full_name: string | null;
  role: StaffRole;
};

export type ParsedInvite = { kind: "ok"; invite: StaffInvite } | { kind: "invalid"; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function parseInvite(body: unknown): ParsedInvite {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { kind: "invalid", error: "Fill in the invitation form and try again." };
  }
  const input = body as Record<string, unknown>;

  const organizationId = typeof input.organization_id === "string" ? input.organization_id.trim() : "";
  if (!UUID.test(organizationId)) return { kind: "invalid", error: "Choose the agency to invite them to." };

  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!email || email.length > 254 || !EMAIL.test(email)) return { kind: "invalid", error: "Enter a valid email address." };

  const rawName = typeof input.full_name === "string" ? input.full_name.trim() : "";
  if (rawName.length > 160) return { kind: "invalid", error: "Keep the name under 160 characters." };

  if (input.role !== "admin" && input.role !== "recruiter") return { kind: "invalid", error: "Choose a role." };

  return {
    kind: "ok",
    invite: { organization_id: organizationId.toLowerCase(), email, full_name: rawName || null, role: input.role },
  };
}

// A bearer token from the Authorization header, or null.
export function bearerToken(request: Request): string | null {
  const match = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}
