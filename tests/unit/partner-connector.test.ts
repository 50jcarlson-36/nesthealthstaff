import { describe, expect, it } from "vitest";
import { apiKey, exportQuery, route, sha256Hex } from "../../supabase/functions/_shared/partner-api.ts";
import {
  csvToUpdates, EXPORT_COLUMNS, type ExportedSubmission, parseCsv, submissionsToCsv, toCsv,
} from "../../supabase/functions/_shared/partner-csv.ts";

const KEY = `nhs_pk_${"a1".repeat(32)}`;
const request = (auth?: string) => new Request("https://x.test/partner-api/events", { headers: auth ? { Authorization: auth } : {} });

describe("apiKey", () => {
  it("accepts a bearer partner key", () => {
    expect(apiKey(request(`Bearer ${KEY}`))).toBe(KEY);
    expect(apiKey(request(`bearer   ${KEY}`))).toBe(KEY);
  });
  it.each([undefined, KEY, `Basic ${KEY}`, `Bearer ${KEY}0`, `Bearer ${KEY.toUpperCase()}`, "Bearer eyJhbGciOi.x.y"])(
    "refuses %s", (auth) => expect(apiKey(request(auth))).toBeNull(),
  );
  it("hashes like the database does", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("route and query", () => {
  it("reads the route after the function name", () => {
    expect(route(new URL("http://h/partner-api/submissions"))).toBe("submissions");
    expect(route(new URL("http://h/functions/v1/partner-api/events/"))).toBe("events");
    expect(route(new URL("http://h/partner-api"))).toBeNull();
    expect(route(new URL("http://h/partner-api/keys"))).toBeNull();
  });
  it("checks since, limit and format", () => {
    const q = (s: string) => exportQuery(new URL(`http://h/partner-api/submissions${s}`));
    expect(q("")).toEqual({ kind: "ok", since: null, limit: 500, format: "json" });
    expect(q("?since=2026-11-01T10:00:00.123456+00:00&limit=10&format=csv")).toMatchObject({ kind: "ok", limit: 10, format: "csv" });
    expect(q("?since=2026-11-01")).toMatchObject({ kind: "ok", since: "2026-11-01" });
    for (const bad of ["?since=yesterday", "?since=2026-13-45", "?limit=0", "?limit=1001", "?limit=2.5", "?format=xml"]) {
      expect(q(bad).kind).toBe("invalid");
    }
  });
});

describe("CSV", () => {
  it("quotes what needs quoting and neutralizes spreadsheet formulas", () => {
    expect(toCsv([["a,b", 'say "hi"', "line\nbreak", null, 3]])).toBe('"a,b","say ""hi""","line\nbreak",,3\r\n');
    expect(toCsv([["=HYPERLINK(\"x\")", "+1", "-2", "@SUM(A1)", "plain"]])).toBe(`"'=HYPERLINK(""x"")",'+1,'-2,'@SUM(A1),plain\r\n`);
  });

  it("parses quotes, BOMs, CRLF and blank lines, and round-trips", () => {
    expect(parseCsv('﻿a,b\r\n"x, ""y""",\n\n"multi\nline",z')).toEqual([["a", "b"], ['x, "y"', ""], ["multi\nline", "z"]]);
    const rows = [["one", "two, three"], ['"q"', ""]];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });

  const submission: ExportedSubmission = {
    submission_id: "11111111-1111-4111-8111-111111111111", partner_candidate_reference: null, status: "submitted",
    submitted_at: "2026-10-30T12:00:00Z", attribution_expires_on: "2027-01-28", stage: "credentialing",
    stage_updated_at: "2026-10-31T12:00:00Z", assignment_start_on: null, assignment_end_on: null,
    candidate: { full_name: "=Ana Synthetic", email: "ana@example.com", phone: null },
    job: { id: "j", title: "Travel RN, ICU", specialty: "ICU", city: "Austin", state: "TX", shift: null, start_date: "2026-12-01", duration_weeks: 13, partner_job_reference: "REQ-7", is_strike: true },
    checklist: [
      { title: "BLS card", owner: "candidate", status: "needed", due_on: "2026-11-20" },
      { title: "Reference check", owner: "partner", status: "received", due_on: null },
    ],
    updated_at: "2026-10-31T12:00:00Z",
  };

  it("exports one row per submission under fixed columns", () => {
    const [header, row] = parseCsv(submissionsToCsv([submission]));
    expect(header).toEqual([...EXPORT_COLUMNS]);
    const get = (c: string) => row[header.indexOf(c)];
    expect(get("candidate_name")).toBe("'=Ana Synthetic");
    expect(get("job_title")).toBe("Travel RN, ICU");
    expect(get("is_strike")).toBe("yes");
    expect(get("missing_items")).toBe("1");
    expect(get("checklist")).toBe("BLS card (needed, candidate, due 2026-11-20); Reference check (received, partner)");
  });

  it("reads a partner's update file into updates, with the file's line numbers", () => {
    const parsed = csvToUpdates(
      "Candidate ID,Status,Start Date,Item,Item Status,Recruiter\r\n" +
      "ATS-1,Interview,,,,Pat\r\n" +
      ",,,,,\r\n" +
      "ATS-2,,2026-12-01,TB test,Received,Sam\r\n",
    );
    expect(parsed).toEqual({
      error: null,
      ignoredColumns: ["Recruiter"],
      lines: [2, 4],
      updates: [
        { partner_candidate_reference: "ATS-1", stage: "Interview" },
        { partner_candidate_reference: "ATS-2", assignment_start_on: "2026-12-01", items: [{ title: "TB test", status: "received" }] },
      ],
    });
  });

  it("accepts our own export back, reading stage rather than the submission status", () => {
    const edited = submissionsToCsv([{ ...submission, stage: "cleared_to_start" }]);
    const parsed = csvToUpdates(edited);
    expect(parsed.error).toBeNull();
    expect(parsed.updates).toEqual([{ submission_id: submission.submission_id, stage: "cleared_to_start" }]);
    expect(parsed.ignoredColumns).toContain("status");
    expect(parsed.ignoredColumns).toContain("candidate_email");
  });

  it("explains files it can't use", () => {
    expect(csvToUpdates("submission_id\n").error).toMatch(/at least one row/);
    expect(csvToUpdates("name,stage\nAna,interview\n").error).toMatch(/submission_id or partner_candidate_reference/);
    expect(csvToUpdates(`reference\n${"x\n".repeat(501)}`).error).toMatch(/500/);
  });
});

describe("edge cases", () => {
  it("reads an unencoded + offset in since", () => {
    expect(exportQuery(new URL("http://h/partner-api/submissions?since=2026-11-01T10:00:00+00:00"))).toMatchObject({
      kind: "ok", since: "2026-11-01T10:00:00+00:00",
    });
  });
  it("counts lines inside quoted fields", () => {
    expect(csvToUpdates('reference,note\nA,"two\nlines"\nB,x\n').lines).toEqual([2, 4]);
  });
});
