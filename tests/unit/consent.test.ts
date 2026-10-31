import { describe, expect, it } from "vitest";
import { parseConsentRequest } from "../../supabase/functions/_shared/consent.ts";
import { DEFAULT_PORTAL_URLS } from "../../supabase/functions/_shared/portals.ts";
import { renderTemplate } from "../../supabase/functions/_shared/templates.ts";

const TOKEN = "ab".repeat(32);

describe("parseConsentRequest", () => {
  it("accepts a 64-hex token and one of the three actions", () => {
    for (const action of ["view", "granted", "declined"]) {
      expect(parseConsentRequest({ token: ` ${TOKEN.toUpperCase()} `, action })).toEqual({ kind: "ok", token: TOKEN, action });
    }
  });

  it.each([
    [null], [[]], [{ action: "view" }], [{ token: "abc", action: "view" }],
    [{ token: `${TOKEN}0`, action: "view" }], [{ token: TOKEN, action: "approve" }], [{ token: TOKEN }],
  ])("refuses %j", (body) => {
    expect(parseConsentRequest(body)).toEqual({ kind: "invalid" });
  });
});

describe("submission_consent_request email", () => {
  const data = {
    organization_name: "Nest Health Staff", partner_name: "Synthetic <Partner>", job_title: "Travel RN, ICU",
    city: "Austin", state: "TX", is_strike: false, expires_at: "2026-11-06T12:00:00Z", token: TOKEN,
  };

  it("names the partner and opening and links to ward's consent page with the token in the fragment", () => {
    const email = renderTemplate("submission_consent_request", data, DEFAULT_PORTAL_URLS);
    expect(email.subject).toBe("Approve your submission: Travel RN, ICU");
    expect(email.text).toContain("Nest Health Staff would like to submit you to Synthetic <Partner> for the Travel RN, ICU opening in Austin, TX.");
    expect(email.text).toContain("The link expires on November 6, 2026.");
    expect(email.text.trimEnd().endsWith(`https://ward.nesthealthstaff.com/consent#${TOKEN}`)).toBe(true);
    expect(email.html).toContain("Synthetic &lt;Partner&gt;");
    expect(email.text).not.toMatch(/strike/i);
  });

  it("labels a strike assignment in the subject and body", () => {
    const email = renderTemplate("submission_consent_request", { ...data, is_strike: true }, DEFAULT_PORTAL_URLS);
    expect(email.subject).toBe("Approve your submission (strike assignment): Travel RN, ICU");
    expect(email.text).toContain("This is a strike assignment.");
  });

  it("refuses to render without a valid token, so a scrubbed row can't be resent", () => {
    const { token: _token, ...scrubbed } = data;
    expect(() => renderTemplate("submission_consent_request", scrubbed, DEFAULT_PORTAL_URLS)).toThrow(/link token/);
  });
});
