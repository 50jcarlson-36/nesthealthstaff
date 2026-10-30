import { describe, expect, it } from "vitest";
import { CONSENT_VERSION, normalizeIdempotencyKey, parseIntake } from "../../supabase/functions/_shared/intake.ts";

// Shape the live website sends today (FormData entries + type + consent boolean).
const nurseForm = {
  name: "  Test   Clinician ",
  email: "Test.Clinician@Example.COM",
  phone: "",
  specialty: "Intensive care / ICU",
  location: "Denver, CO",
  timeline: "Within 1–3 months",
  website: "",
  type: "nurse",
  consent: true,
};

describe("parseIntake", () => {
  it("accepts the live nurse form and normalizes it", () => {
    const result = parseIntake(nurseForm);
    expect(result).toEqual({
      kind: "valid",
      inquiry: {
        inquiry_type: "clinician",
        full_name: "Test Clinician",
        email: "test.clinician@example.com",
        phone: null,
        specialty: "Intensive care / ICU",
        preferred_location: "Denver, CO",
        timeline: "within_1_3_months",
        housing_assistance_requested: false,
        organization_name: null,
        staffing_type: null,
        headcount: null,
        desired_start_date: null,
        desired_end_date: null,
        staffing_requirements: null,
        consent_version: CONSENT_VERSION,
      },
    });
  });

  it("maps employer submissions to facility inquiries and requires an organization", () => {
    const missing = parseIntake({ ...nurseForm, type: "employer" });
    expect(missing).toEqual({ kind: "invalid", error: "Please enter your organization's name." });

    const ok = parseIntake({ ...nurseForm, type: "employer", organization: "Example Regional Hospital", headcount: "4" });
    expect(ok.kind).toBe("valid");
    if (ok.kind === "valid") {
      expect(ok.inquiry.inquiry_type).toBe("facility");
      expect(ok.inquiry.organization_name).toBe("Example Regional Hospital");
      expect(ok.inquiry.headcount).toBe(4);
    }
  });

  it("treats a filled honeypot as a bot without validating further", () => {
    expect(parseIntake({ website: "http://spam.example" })).toEqual({ kind: "honeypot" });
  });

  it.each([
    [{ ...nurseForm, consent: false }, "Please agree to be contacted so we can follow up."],
    [{ ...nurseForm, email: "not-an-email" }, "Please enter a valid email address."],
    [{ ...nurseForm, name: "A" }, "Please enter your name."],
    [{ ...nurseForm, type: "admin" }, "Please choose nurse or employer."],
    [{ ...nurseForm, timeline: "Tomorrow" }, "Please choose a start timing from the list."],
    [{ ...nurseForm, location: "x".repeat(161) }, "Location must be 160 characters or fewer."],
    [{ ...nurseForm, name: { first: "x" } }, "Name must be text."],
    [{ ...nurseForm, headcount: "2.5" }, "Headcount must be a whole number between 1 and 1000."],
    [{ ...nurseForm, desired_start_date: "2027-02-01", desired_end_date: "2027-01-01" }, "End date must be on or after the start date."],
  ])("rejects invalid input %#", (input, error) => {
    expect(parseIntake(input)).toEqual({ kind: "invalid", error });
  });

  it("rejects non-object bodies", () => {
    for (const body of [null, "text", [1, 2], 42]) {
      expect(parseIntake(body).kind).toBe("invalid");
    }
  });

  it("ignores fields it does not know, including client-supplied organization ids", () => {
    const result = parseIntake({ ...nurseForm, organization_id: "00000000-0000-0000-0000-000000000000", role: "admin" });
    expect(result.kind).toBe("valid");
    if (result.kind === "valid") {
      expect(result.inquiry).not.toHaveProperty("organization_id");
      expect(result.inquiry).not.toHaveProperty("role");
    }
  });
});

describe("normalizeIdempotencyKey", () => {
  it("accepts printable keys of a sensible length and ignores the rest", () => {
    expect(normalizeIdempotencyKey(" 7f0c2c1e-retry-key ")).toBe("7f0c2c1e-retry-key");
    expect(normalizeIdempotencyKey("short")).toBeNull();
    expect(normalizeIdempotencyKey("has spaces in it")).toBeNull();
    expect(normalizeIdempotencyKey(null)).toBeNull();
  });
});
