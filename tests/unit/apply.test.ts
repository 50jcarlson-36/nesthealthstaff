import { describe, expect, it } from "vitest";
import { APPLICATION_CONSENT_VERSION, parseApplication } from "../../supabase/functions/_shared/apply.ts";

const JOB_ID = "0E16D69E-0A81-405A-8A60-DE42B9A9EB79";

const form = {
  job_id: JOB_ID,
  name: "  Test   Applicant ",
  email: "Test.Applicant@Example.COM",
  phone: "",
  website: "",
  consent: true,
};

describe("parseApplication", () => {
  it("accepts a complete form and normalizes it", () => {
    expect(parseApplication(form)).toEqual({
      kind: "valid",
      application: {
        job_id: JOB_ID.toLowerCase(),
        full_name: "Test Applicant",
        email: "test.applicant@example.com",
        phone: null,
        consent_version: APPLICATION_CONSENT_VERSION,
      },
    });
  });

  it("accepts full_name and form-encoded consent values", () => {
    for (const consent of ["true", "on", "yes"]) {
      const result = parseApplication({ job_id: JOB_ID, full_name: "Pat Example", email: "pat@example.com", phone: " 555-0100 ", consent });
      expect(result).toMatchObject({ kind: "valid", application: { full_name: "Pat Example", phone: "555-0100" } });
    }
  });

  it("drops fields it doesn't collect", () => {
    const result = parseApplication({ ...form, license_number: "RN123", notes: "anything", organization_id: "x" });
    expect(result.kind).toBe("valid");
    if (result.kind === "valid") {
      expect(Object.keys(result.application).sort()).toEqual(["consent_version", "email", "full_name", "job_id", "phone"]);
    }
  });

  it("treats a filled honeypot as a bot", () => {
    expect(parseApplication({ ...form, website: "http://spam.example" })).toEqual({ kind: "honeypot" });
  });

  it.each([
    [{ ...form, job_id: "not-a-uuid" }, "We couldn't find that job. Please go back to the job list."],
    [{ ...form, job_id: undefined }, "We couldn't find that job. Please go back to the job list."],
    [{ ...form, name: " x " }, "Please enter your name."],
    [{ ...form, name: 42 }, "Name must be text."],
    [{ ...form, email: "nope" }, "Please enter a valid email address."],
    [{ ...form, consent: false }, "Please agree to be contacted about this job."],
    [{ ...form, consent: "false" }, "Please agree to be contacted about this job."],
    [{ ...form, phone: "5".repeat(41) }, "Phone must be 40 characters or fewer."],
    [{ ...form, name: "a".repeat(161) }, "Name must be 160 characters or fewer."],
  ])("rejects %j", (body, error) => {
    expect(parseApplication(body)).toEqual({ kind: "invalid", error });
  });

  it("rejects bodies that aren't objects", () => {
    for (const body of [null, "text", [form], 7]) {
      expect(parseApplication(body)).toEqual({ kind: "invalid", error: "Please complete the form and try again." });
    }
  });
});
