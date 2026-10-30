// Candidate journeys: every open application on a partner opening, with its
// next action and whether it's overdue (computed by journey_overview), plus
// the stage, assignment dates and checklist on each application.

import { type FormEvent, useEffect, useState } from "react";
import type { PartnerSubmission } from "./partners.tsx";
import { formatDate, label, Link, type Save, useSave } from "./shared.tsx";
import { supabase } from "./supabase.ts";

type Navigate = (to: string) => void;

export const JOURNEY_STAGES = [
  "submitted", "partner_review", "interview", "offer", "offer_accepted", "credentialing",
  "cleared_to_start", "started", "extended", "completed", "declined", "cancelled",
] as const;
export type JourneyStage = (typeof JOURNEY_STAGES)[number];
const ENDING: JourneyStage[] = ["declined", "cancelled"];
const NEEDS_START: JourneyStage[] = ["started", "extended", "completed"];
const OWNERS = { nest: "Nest", partner: "Partner", candidate: "Candidate" } as const;
type Owner = keyof typeof OWNERS;

type OverviewRow = {
  application_id: string;
  job_id: string;
  full_name: string;
  job_title: string;
  city: string;
  state: string;
  partner_name: string;
  is_strike: boolean;
  priority: "normal" | "high" | "critical";
  consent_status: string | null;
  journey_stage: JourneyStage | null;
  submitted_by: string | null;
  assignment_start_on: string | null;
  missing_items: number;
  next_action: string;
  next_action_due: string;
  overdue: boolean;
};

export type JourneyItem = {
  id: string;
  application_id: string;
  title: string;
  owner: Owner;
  status: "needed" | "received" | "waived";
  due_on: string | null;
  note: string | null;
  source: "manual" | "partner_requirement";
  version: number;
};

export type JourneySubmission = PartnerSubmission & {
  stage: JourneyStage;
  stage_updated_at: string;
  stage_note: string | null;
  assignment_start_on: string | null;
  assignment_end_on: string | null;
};

const stageLabel = (r: OverviewRow) =>
  r.journey_stage ? label(r.journey_stage) : r.consent_status === "pending" ? "Awaiting approval" : r.consent_status === "granted" ? "Approved" : "Not submitted";

// --- List -------------------------------------------------------------------------

export function JourneyList({ navigate, userId }: { navigate: Navigate; userId: string }) {
  const [rows, setRows] = useState<OverviewRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"overdue" | "week" | "mine" | "all">("overdue");

  useEffect(() => {
    supabase.from("journey_overview").select("*").order("next_action_due").limit(500).then(({ data, error }) => {
      if (error) setError("Couldn't load journeys.");
      else setRows(data as OverviewRow[]);
    });
  }, []);

  const weekAhead = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const shown = rows?.filter((r) =>
    view === "overdue" ? r.overdue : view === "week" ? r.next_action_due <= weekAhead : view === "mine" ? r.submitted_by === userId : true,
  ).sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.next_action_due.localeCompare(b.next_action_due));
  const count = (f: (r: OverviewRow) => boolean) => rows?.filter(f).length ?? "—";

  return (
    <section>
      <div className="page-intro"><div><p className="eyebrow">EVERY NEXT STEP</p><h1>Where every candidate stands.</h1><p className="muted">Status, what's missing and what to do next, for each candidate on a partner opening.</p></div></div>
      <div className="metric-grid">
        {([["Overdue", count((r) => r.overdue)], ["Due this week", count((r) => r.next_action_due <= weekAhead)], ["Missing items", rows?.reduce((n, r) => n + r.missing_items, 0) ?? "—"], ["Open journeys", rows?.length ?? "—"]] as [string, number | string][]).map(([t, v]) => (
          <div className="metric" key={t}><span>{t}</span><strong>{v}</strong></div>
        ))}
      </div>
      <div className="toolbar">
        <h2>Journeys</h2>
        <label>
          Show{" "}
          <select value={view} onChange={(e) => setView(e.target.value as typeof view)}>
            <option value="overdue">Overdue</option>
            <option value="week">Due in the next 7 days</option>
            <option value="mine">Submitted by me</option>
            <option value="all">All open</option>
          </select>
        </label>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      {!rows && !error && <p className="muted">Loading…</p>}
      {shown && shown.length === 0 && <p className="muted">{view === "overdue" ? "Nothing is overdue." : "No journeys match."}</p>}
      {shown && shown.length > 0 && (
        <table>
          <thead><tr><th>Candidate</th><th>Opening</th><th>Partner</th><th>Stage</th><th>Next action</th><th>Due</th><th>Missing</th></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.application_id} className={r.overdue ? "overdue" : undefined}>
                <td><Link to={`/jobs/${r.job_id}`} navigate={navigate}>{r.full_name}</Link></td>
                <td>
                  {r.job_title}<br /><span className="muted">{r.city}, {r.state}</span>
                  {r.is_strike && <> <span className="stage strike">Strike</span></>}
                  {r.priority !== "normal" && <> <span className={`stage priority-${r.priority}`}>{label(r.priority)}</span></>}
                </td>
                <td>{r.partner_name}</td>
                <td><span className="stage">{stageLabel(r)}</span></td>
                <td>{r.next_action}</td>
                <td>{r.overdue ? <strong className="error">{formatDate(r.next_action_due)}</strong> : formatDate(r.next_action_due)}</td>
                <td>{r.missing_items || <span className="muted">0</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// --- On an application ------------------------------------------------------------------

export function JourneyPanel({ applicationId, submission, items, save }: {
  applicationId: string;
  submission: JourneySubmission | undefined;
  items: JourneyItem[];
  save: Save;
}) {
  const live = submission && submission.status === "submitted";
  return (
    <div className="action journey">
      {live && <StageForm key={submission.version} submission={submission} save={save} />}
      <Checklist applicationId={applicationId} items={items} save={save} />
    </div>
  );
}

function StageForm({ submission: s, save }: { submission: JourneySubmission; save: Save }) {
  const [stage, setStage] = useState<JourneyStage>(s.stage);
  const [start, setStart] = useState(s.assignment_start_on ?? "");
  const [end, setEnd] = useState(s.assignment_end_on ?? "");
  const [note, setNote] = useState(s.stage_note ?? "");
  const { saving, error, run } = useSave(save);

  function submit(e: FormEvent) {
    e.preventDefault();
    run(() => supabase.rpc("update_journey_stage", {
      p_submission_id: s.id, p_expected_version: s.version, p_stage: stage,
      p_note: note.trim() || null, p_start_on: start || null, p_end_on: end || null,
    }));
  }

  return (
    <form onSubmit={submit}>
      <p>Journey: <strong>{label(s.stage)}</strong> since {formatDate(s.stage_updated_at)}{s.stage_note ? ` · ${s.stage_note}` : ""}</p>
      <div className="row">
        <select aria-label="Journey stage" value={stage} onChange={(e) => setStage(e.target.value as JourneyStage)}>
          {JOURNEY_STAGES.map((x) => <option key={x} value={x}>{label(x)}</option>)}
        </select>
        <input aria-label="Assignment start" type="date" value={start} onChange={(e) => setStart(e.target.value)} required={NEEDS_START.includes(stage)} title="Assignment start" />
        <input aria-label="Assignment end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} title="Assignment end" />
      </div>
      <div className="row">
        <input aria-label="Stage note" placeholder={ENDING.includes(stage) ? "Reason (required)" : "Note (optional)"} maxLength={1000}
          required={ENDING.includes(stage) && stage !== s.stage} value={note} onChange={(e) => setNote(e.target.value)} />
        <button type="submit" disabled={saving}>{saving ? "Saving…" : "Update journey"}</button>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
    </form>
  );
}

function Checklist({ applicationId, items, save }: { applicationId: string; items: JourneyItem[]; save: Save }) {
  const [title, setTitle] = useState("");
  const [owner, setOwner] = useState<Owner>("candidate");
  const [due, setDue] = useState("");
  const [waiveReason, setWaiveReason] = useState<Record<string, string>>({});
  const { saving, error, run } = useSave(save);
  const today = new Date().toISOString().slice(0, 10);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (await run(() => supabase.rpc("add_journey_item", { p_application_id: applicationId, p_title: title, p_owner: owner, p_due_on: due || null, p_note: null }))) {
      setTitle("");
      setDue("");
    }
  }
  const setStatus = (i: JourneyItem, status: JourneyItem["status"], note: string | null = null) =>
    run(() => supabase.rpc("set_journey_item_status", { p_item_id: i.id, p_expected_version: i.version, p_status: status, p_note: note }));

  const missing = items.filter((i) => i.status === "needed").length;
  return (
    <details open={missing > 0}>
      <summary className="muted">Checklist: {missing ? `${missing} missing` : items.length ? "complete" : "empty"}</summary>
      <p className="muted hint">Track that each item exists and who owns it. Don't upload or paste documents here: credentialing files stay with the partner.</p>
      {items.length > 0 && (
        <ul className="checklist">
          {items.map((i) => (
            <li key={i.id} className={`item-${i.status}`}>
              <span>
                <strong>{i.title}</strong> · {OWNERS[i.owner]}
                {i.due_on && <> · due {i.status === "needed" && i.due_on < today ? <strong className="error">{formatDate(i.due_on)}</strong> : formatDate(i.due_on)}</>}
                {i.status !== "needed" && <> · <em>{label(i.status)}</em></>}
                {i.note && <span className="muted"> · {i.note}</span>}
              </span>
              <span className="row">
                {i.status === "needed" ? (
                  <>
                    <button type="button" className="link" disabled={saving} onClick={() => setStatus(i, "received")}>Received</button>
                    <input aria-label={`Why ${i.title} isn't needed`} placeholder="Why not needed" maxLength={1000} value={waiveReason[i.id] ?? ""} onChange={(e) => setWaiveReason((w) => ({ ...w, [i.id]: e.target.value }))} />
                    <button type="button" className="link" disabled={saving || !(waiveReason[i.id] ?? "").trim()} onClick={() => setStatus(i, "waived", waiveReason[i.id])}>Waive</button>
                  </>
                ) : (
                  <button type="button" className="link" disabled={saving} onClick={() => setStatus(i, "needed")}>Reopen</button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <form className="row" onSubmit={add}>
        <input aria-label="New checklist item" placeholder="Add an item, e.g. Skills checklist" maxLength={200} required value={title} onChange={(e) => setTitle(e.target.value)} />
        <select aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value as Owner)}>
          {Object.entries(OWNERS).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
        </select>
        <input aria-label="Due date" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        <button type="submit" disabled={saving}>Add</button>
      </form>
      <p>
        <button type="button" className="link" disabled={saving} onClick={() => run(() => supabase.rpc("add_travel_checklist", { p_application_id: applicationId }))}>
          Add the travel steps
        </button>
        <span className="muted hint"> License, stipend eligibility, housing, travel, commute and first-day details, due before the start date.</span>
      </p>
      {error && <p role="alert" className="error">{error}</p>}
    </details>
  );
}

// --- Partner requirements (on the partner page) ------------------------------------------

type Requirement = { title: string; owner: Owner; due_days_before_start: number | null };

export function PartnerRequirements({ partnerId, isAdmin }: { partnerId: string; isAdmin: boolean }) {
  const [rows, setRows] = useState<Requirement[] | null>(null);
  const [editing, setEditing] = useState<Requirement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () => supabase.from("partner_requirements").select("title, owner, due_days_before_start").eq("partner_id", partnerId).order("position")
    .then(({ data }) => setRows((data ?? []) as Requirement[]));
  useEffect(() => { load(); }, [partnerId]);

  async function saveAll() {
    setSaving(true);
    const { error } = await supabase.rpc("set_partner_requirements", { p_partner_id: partnerId, p_requirements: editing!.filter((r) => r.title.trim()) });
    setSaving(false);
    if (error) return setError(error.code === "PT400" ? error.message : "Couldn't save the requirements.");
    setError(null);
    setEditing(null);
    load();
  }
  const update = (i: number, patch: Partial<Requirement>) => setEditing((e) => e!.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="card">
      <div className="toolbar">
        <h3>Standard requirements</h3>
        {isAdmin && !editing && <button onClick={() => setEditing(rows ?? [])}>Edit requirements</button>}
      </div>
      <p className="muted hint">Added to a candidate's checklist when they're submitted to this partner.</p>
      {!editing && rows && (rows.length === 0 ? <p className="muted">None yet.</p> : (
        <ul className="checklist">{rows.map((r, i) => <li key={i}><span><strong>{r.title}</strong> · {OWNERS[r.owner]}{r.due_days_before_start !== null ? ` · due ${r.due_days_before_start} days before start` : ""}</span></li>)}</ul>
      ))}
      {editing && (
        <>
          {editing.map((r, i) => (
            <div className="row" key={i}>
              <input aria-label="Requirement" maxLength={200} value={r.title} onChange={(e) => update(i, { title: e.target.value })} />
              <select aria-label="Owner" value={r.owner} onChange={(e) => update(i, { owner: e.target.value as Owner })}>
                {Object.entries(OWNERS).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
              </select>
              <input aria-label="Days before start" type="number" min={0} max={120} placeholder="Days before start" value={r.due_days_before_start ?? ""} onChange={(e) => update(i, { due_days_before_start: e.target.value ? Number(e.target.value) : null })} />
              <button type="button" className="link" onClick={() => setEditing((e) => e!.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          <p><button type="button" className="link" onClick={() => setEditing((e) => [...e!, { title: "", owner: "candidate", due_days_before_start: null }])}>Add a requirement</button></p>
          {error && <p role="alert" className="error">{error}</p>}
          <div className="row"><button disabled={saving} onClick={saveAll}>{saving ? "Saving…" : "Save requirements"}</button><button className="link" onClick={() => { setEditing(null); setError(null); }}>Cancel</button></div>
        </>
      )}
    </div>
  );
}
