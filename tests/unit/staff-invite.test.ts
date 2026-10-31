import { describe, expect, it } from "vitest";
import { DEFAULT_PORTAL_URLS } from "../../supabase/functions/_shared/portals.ts";
import { bearerToken, parseInvite } from "../../supabase/functions/_shared/staff-invite.ts";
import { renderTemplate } from "../../supabase/functions/_shared/templates.ts";

const ORG = "6f1c2a3b-4d5e-4f60-8a1b-2c3d4e5f6a7b";

describe("parseInvite", () => {
  it("normalizes the address and name", () => {
    expect(parseInvite({ organization_id: ORG.toUpperCase(), email: "  New.Hire@Example.COM ", full_name: "  Riley  ", role: "admin" }))
      .toEqual({ kind: "ok", invite: { organization_id: ORG, email: "new.hire@example.com", full_name: "Riley", role: "admin" } });
    expect(parseInvite({ organization_id: ORG, email: "a@example.com", full_name: "   ", role: "recruiter" }))
      .toMatchObject({ kind: "ok", invite: { full_name: null } });
  });

  it("drops fields it doesn't know", () => {
    const parsed = parseInvite({ organization_id: ORG, email: "a@example.com", role: "recruiter", user_id: "x", organizations: [] });
    expect(parsed.kind === "ok" && Object.keys(parsed.invite).sort()).toEqual(["email", "full_name", "organization_id", "role"]);
  });

  it.each([
    [null, "Fill in the invitation form and try again."],
    [[], "Fill in the invitation form and try again."],
    [{ email: "a@example.com", role: "admin" }, "Choose the agency to invite them to."],
    [{ organization_id: ORG, email: "not-an-email", role: "admin" }, "Enter a valid email address."],
    [{ organization_id: ORG, email: `${"a".repeat(250)}@example.com`, role: "admin" }, "Enter a valid email address."],
    [{ organization_id: ORG, email: "a@example.com", full_name: "x".repeat(161), role: "admin" }, "Keep the name under 160 characters."],
    [{ organization_id: ORG, email: "a@example.com", role: "owner" }, "Choose a role."],
  ])("rejects %j", (body, error) => {
    expect(parseInvite(body)).toEqual({ kind: "invalid", error });
  });
});

describe("bearerToken", () => {
  const request = (value?: string) => new Request("http://localhost/", { headers: value ? { Authorization: value } : {} });
  it("reads only a well-formed bearer header", () => {
    expect(bearerToken(request("Bearer abc.def"))).toBe("abc.def");
    expect(bearerToken(request("bearer abc"))).toBe("abc");
    expect(bearerToken(request("Basic abc"))).toBeNull();
    expect(bearerToken(request("Bearer"))).toBeNull();
    expect(bearerToken(request())).toBeNull();
  });
});

describe("staff_invitation email", () => {
  it("names the agency, role and inviter, links to ward's sign-in and holds no token", () => {
    const email = renderTemplate("staff_invitation", {
      organization_name: "Nest Health Staff",
      role: "admin",
      inviter_name: "Avery <Admin>",
      expires_at: "2026-11-12T16:00:00Z",
    }, DEFAULT_PORTAL_URLS);
    expect(email.subject).toBe("You're invited to Nest Health Staff on Ward");
    expect(email.text).toContain("Avery <Admin> has invited you to join Nest Health Staff in Ward, its recruiting workspace, as an admin.");
    expect(email.text).toContain("The invitation expires on November 12, 2026.");
    expect(email.text.trimEnd().endsWith("https://ward.nesthealthstaff.com/")).toBe(true);
    expect(email.html).toContain("Avery &lt;Admin&gt;");
    expect(email.html).toContain('href="https://ward.nesthealthstaff.com/"');
    expect(email.text).not.toMatch(/token|code=|#access/i);
  });

  it("reads as a plain invitation when the inviter and expiry are missing", () => {
    const email = renderTemplate("staff_invitation", { role: "recruiter" }, DEFAULT_PORTAL_URLS);
    expect(email.text).toMatch(/^You've been invited to join Nest Health Staff in Ward, its recruiting workspace, as a recruiter\./);
    expect(email.text).not.toContain("expires");
  });
});
