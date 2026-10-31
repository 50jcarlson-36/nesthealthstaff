// CSV for the partner connector: the submissions export, and partner update
// files turned into the update objects that import_partner_updates and
// partner_api_event accept. Shared by the partner-api function and ward, so
// both write the same columns. Plain TypeScript, no dependencies.

export type ChecklistItem = { title: string; owner: string; status: string; due_on: string | null };

export type ExportedSubmission = {
  submission_id: string;
  partner_candidate_reference: string | null;
  status: string;
  submitted_at: string;
  attribution_expires_on: string;
  stage: string;
  stage_updated_at: string;
  assignment_start_on: string | null;
  assignment_end_on: string | null;
  candidate: { full_name: string; email: string; phone: string | null } | null;
  job: {
    id: string;
    title: string;
    specialty: string;
    city: string;
    state: string;
    shift: string | null;
    start_date: string | null;
    duration_weeks: number | null;
    partner_job_reference: string | null;
    is_strike: boolean;
  };
  checklist: ChecklistItem[];
  updated_at: string;
};

export type PartnerUpdate = {
  submission_id?: string;
  partner_candidate_reference?: string;
  stage?: string;
  assignment_start_on?: string;
  assignment_end_on?: string;
  note?: string;
  items?: { title: string; status?: string; owner?: string; due_on?: string; note?: string }[];
};

// --- Writing -------------------------------------------------------------------

// Spreadsheet apps run cells that start with these as formulas. Candidate
// names come from a public form, so such cells are prefixed with a quote.
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

export const EXPORT_COLUMNS = [
  "submission_id", "partner_candidate_reference", "status", "submitted_at", "attribution_expires_on",
  "candidate_name", "candidate_email", "candidate_phone",
  "job_title", "specialty", "city", "state", "shift", "job_start_date", "duration_weeks",
  "partner_job_reference", "is_strike",
  "stage", "stage_updated_at", "assignment_start_on", "assignment_end_on",
  "missing_items", "checklist", "updated_at",
] as const;

function checklistText(items: ChecklistItem[]): string {
  return items
    .map((i) => `${i.title} (${i.status}, ${i.owner}${i.due_on ? `, due ${i.due_on}` : ""})`)
    .join("; ");
}

export function submissionsToCsv(submissions: ExportedSubmission[]): string {
  return toCsv([
    [...EXPORT_COLUMNS],
    ...submissions.map((s) => [
      s.submission_id, s.partner_candidate_reference, s.status, s.submitted_at, s.attribution_expires_on,
      s.candidate?.full_name, s.candidate?.email, s.candidate?.phone,
      s.job.title, s.job.specialty, s.job.city, s.job.state, s.job.shift, s.job.start_date, s.job.duration_weeks,
      s.job.partner_job_reference, s.job.is_strike ? "yes" : "no",
      s.stage, s.stage_updated_at, s.assignment_start_on, s.assignment_end_on,
      s.checklist.filter((i) => i.status === "needed").length, checklistText(s.checklist), s.updated_at,
    ]),
  ]);
}

// --- Reading -------------------------------------------------------------------

// RFC 4180, plus the quirks of real exports: a byte-order mark, bare \n line
// ends and blank lines. Also returns the file line each row starts on.
export function parseCsvLines(text: string): { rows: string[][]; lines: number[] } {
  const rows: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  const end = () => {
    row.push(field);
    if (row.some((f) => f !== "")) { rows.push(row); lines.push(rowLine); }
    row = [];
    field = "";
  };
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else {
        if (c === "\n" || (c === "\r" && text[i + 1] !== "\n")) line++;
        field += c;
      }
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      end();
      line++;
      rowLine = line;
    } else field += c;
  }
  end();
  return { rows, lines };
}

export function parseCsv(text: string): string[][] {
  return parseCsvLines(text).rows;
}

// Header names a partner might use, mapped to ours. Matching ignores case,
// spaces and punctuation.
const HEADER_ALIASES: Record<string, keyof RowFields> = {
  submissionid: "submission_id", nestsubmissionid: "submission_id",
  partnercandidatereference: "partner_candidate_reference", candidatereference: "partner_candidate_reference",
  reference: "partner_candidate_reference", candidateid: "partner_candidate_reference",
  stage: "stage", status: "stage_or_status",
  assignmentstarton: "assignment_start_on", startdate: "assignment_start_on", assignmentstart: "assignment_start_on",
  assignmentendon: "assignment_end_on", enddate: "assignment_end_on", assignmentend: "assignment_end_on",
  note: "note", notes: "note",
  item: "item", itemtitle: "item", requirement: "item",
  itemstatus: "item_status", itemowner: "item_owner", itemdueon: "item_due_on", itemduedate: "item_due_on",
  itemnote: "item_note",
};

type RowFields = {
  submission_id: string;
  partner_candidate_reference: string;
  stage: string;
  stage_or_status: string;
  assignment_start_on: string;
  assignment_end_on: string;
  note: string;
  item: string;
  item_status: string;
  item_owner: string;
  item_due_on: string;
  item_note: string;
};

const normalize = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

export type ParsedImport = {
  updates: PartnerUpdate[];
  // The file's line for each update, for messages. Line 1 is the header.
  lines: number[];
  ignoredColumns: string[];
  error: string | null;
};

// One update per row. Our own export can be edited and sent back: its
// submission_id, stage and date columns are read, the rest ignored. A
// "status" column means the journey stage unless the file also has "stage"
// (in our export, status is the submission's status).
export function csvToUpdates(text: string): ParsedImport {
  const { rows, lines: fileLines } = parseCsvLines(text);
  const empty = { updates: [], lines: [], ignoredColumns: [] };
  if (rows.length < 2) return { ...empty, error: "The file needs a header row and at least one row of updates." };
  if (rows.length > 501) return { ...empty, error: "Import up to 500 rows at a time." };

  const header = rows[0].map((h) => HEADER_ALIASES[normalize(h)]);
  const hasStage = header.includes("stage");
  const ignoredColumns = rows[0].filter((_, i) => !header[i] || (header[i] === "stage_or_status" && hasStage));
  if (!header.includes("submission_id") && !header.includes("partner_candidate_reference")) {
    return { ...empty, ignoredColumns, error: "The file needs a submission_id or partner_candidate_reference column." };
  }

  const updates: PartnerUpdate[] = [];
  const lines: number[] = [];
  rows.slice(1).forEach((row, index) => {
    const f: Partial<RowFields> = {};
    header.forEach((key, i) => {
      const value = (row[i] ?? "").trim();
      if (!key || value === "") return;
      if (key === "stage_or_status") { if (!hasStage) f.stage = value; return; }
      f[key] = value;
    });
    const u: PartnerUpdate = {};
    if (f.submission_id) u.submission_id = f.submission_id;
    if (f.partner_candidate_reference) u.partner_candidate_reference = f.partner_candidate_reference;
    if (f.stage) u.stage = f.stage;
    if (f.assignment_start_on) u.assignment_start_on = f.assignment_start_on;
    if (f.assignment_end_on) u.assignment_end_on = f.assignment_end_on;
    if (f.note) u.note = f.note;
    if (f.item) {
      u.items = [{
        title: f.item,
        ...(f.item_status && { status: f.item_status.toLowerCase() }),
        ...(f.item_owner && { owner: f.item_owner.toLowerCase() }),
        ...(f.item_due_on && { due_on: f.item_due_on }),
        ...(f.item_note && { note: f.item_note }),
      }];
    }
    updates.push(u);
    lines.push(fileLines[index + 1]);
  });
  return { updates, lines, ignoredColumns, error: null };
}
