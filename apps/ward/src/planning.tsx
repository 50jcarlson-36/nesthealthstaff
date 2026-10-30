// Next assignments: clinicians whose assignment ends soon, the plan for each,
// and the open jobs that could come next, ranked with the opportunity score
// and compared with what they earn now.

import { type FormEvent, useEffect, useState } from "react";
import { dollars } from "./partners.tsx";
import { scoreClass } from "./scores.tsx";
import { formatDate, label, Link } from "./shared.tsx";
import { pipelineError, supabase } from "./supabase.ts";

type Navigate = (to: string) => void;
type PlanStatus = "not_started" | "extension_offered" | "extending" | "looking" | "next_lined_up" | "not_continuing";

const PLAN_STATUSES: Record<PlanStatus, string> = {
  not_started: "Not started",
  extension_offered: "Extension offered",
  extending: "Extending",
  looking: "Looking for the next one",
  next_lined_up: "Next one lined up",
  not_continuing: "Not continuing",
};
const SETTLED: PlanStatus[] = ["extending", "next_lined_up", "not_continuing"];

type Ending = {
  application_id: string;
  full_name: string;
  stage: string;
  assignment_end_on: string;
  days_left: number;
  job_id: string;
  job_title: string;
  city: string;
  state: string;
  partner_name: string;
  current_weekly_cents: number | null;
  extension_bonus_cents: number | null;
  plan_status: PlanStatus;
  plan_note: string | null;
  plan_version: number | null;
  next_job_id: string | null;
};

type Option = {
  job_id: string;
  title: string;
  city: string;
  state: string;
  start_date: string | null;
  is_strike: boolean;
  is_crisis_rate: boolean;
  effective_weekly_cents: number | null;
  pay_change_pct: number | null;
  opportunity_score: number;
  fit_score: number;
  fit_reasons: string[];
  rank: number;
};

export function NextAssignments({ navigate }: { navigate: Navigate }) {
  const [rows, setRows] = useState<Ending[] | null>(null);
  const [error, setError] = useState(false);
  const [weeks, setWeeks] = useState(8);
  const [open, setOpen] = useState<string | null>(null);

  const load = () => supabase.from("assignment_endings").select("*").order("assignment_end_on").then(({ data, error }) => {
    setError(Boolean(error));
    setRows((data ?? []) as Ending[]);
  });
  useEffect(() => { load(); }, []);

  const shown = rows?.filter((r) => r.days_left <= weeks * 7);
  const count = (f: (r: Ending) => boolean) => shown?.filter(f).length ?? "—";

  return (
    <section>
      <div className="page-intro"><div><p className="eyebrow">WHAT COMES NEXT</p><h1>Every next chapter, planned early.</h1><p className="muted">Clinicians whose assignment ends soon: extend, line up the next one, or let them go well.</p></div></div>
      <div className="metric-grid">
        {([["Ending in range", shown?.length ?? "—"], ["No plan yet", count((r) => r.plan_status === "not_started")],
           ["Ending in 4 weeks, unsettled", count((r) => r.days_left <= 28 && !SETTLED.includes(r.plan_status))],
           ["Settled", count((r) => SETTLED.includes(r.plan_status))]] as [string, number | string][]).map(([t, v]) => (
          <div className="metric" key={t}><span>{t}</span><strong>{v}</strong></div>
        ))}
      </div>
      <div className="toolbar">
        <h2>Next assignments</h2>
        <label>Ending within{" "}
          <select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>
            {[4, 8, 12, 16].map((w) => <option key={w} value={w}>{w} weeks</option>)}
          </select>
        </label>
      </div>
      {error && <p role="alert" className="error">Couldn't load assignments.</p>}
      {!rows && !error && <p className="muted">Loading…</p>}
      {shown && shown.length === 0 && <p className="muted">No assignments end in this range. Assignments appear here once a journey is marked started or extended with an end date.</p>}
      {shown && shown.length > 0 && (
        <ul className="notes endings">
          {shown.map((r) => (
            <li key={r.application_id} className={`card${r.days_left <= 28 && !SETTLED.includes(r.plan_status) ? " overdue" : ""}`}>
              <div className="ending-head">
                <div>
                  <strong>{r.full_name}</strong> · <Link to={`/jobs/${r.job_id}`} navigate={navigate}>{r.job_title}</Link>
                  <div className="muted">{r.city}, {r.state} · {r.partner_name} · {label(r.stage)}</div>
                </div>
                <div className="ending-facts">
                  <span>Ends <strong>{formatDate(r.assignment_end_on)}</strong> <span className="muted">({r.days_left < 0 ? `${-r.days_left} days ago` : `${r.days_left} days`})</span></span>
                  <span className="muted">{r.current_weekly_cents ? `${dollars(r.current_weekly_cents)}/week now` : "Pay not on file"}
                    {r.extension_bonus_cents ? ` · ${dollars(r.extension_bonus_cents)} extension bonus` : ""}</span>
                  <span className={`stage plan-${r.plan_status}`}>{PLAN_STATUSES[r.plan_status]}</span>
                </div>
              </div>
              {r.plan_note && <p className="muted">{r.plan_note}</p>}
              <button className="link" onClick={() => setOpen(open === r.application_id ? null : r.application_id)}>
                {open === r.application_id ? "Close plan" : "Plan the next assignment"}
              </button>
              {open === r.application_id && <PlanPanel key={r.plan_version ?? 0} ending={r} navigate={navigate} onSaved={load} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PlanPanel({ ending, navigate, onSaved }: { ending: Ending; navigate: Navigate; onSaved: () => void }) {
  const [status, setStatus] = useState<PlanStatus>(ending.plan_status);
  const [note, setNote] = useState(ending.plan_note ?? "");
  const [options, setOptions] = useState<Option[] | null>(null);
  const [sort, setSort] = useState<"match" | "pay">("match");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [putForward, setPutForward] = useState<string | null>(ending.next_job_id);

  useEffect(() => {
    supabase.rpc("next_assignment_options", { p_application_id: ending.application_id }).then(({ data }) => setOptions((data ?? []) as Option[]));
  }, [ending.application_id]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.rpc("set_next_assignment_plan", {
      p_application_id: ending.application_id, p_expected_version: ending.plan_version, p_status: status, p_note: note.trim() || null,
    });
    setBusy(false);
    if (error) return setError(pipelineError(error, "plan"));
    setError(null);
    onSaved();
  }

  async function forward(jobId: string) {
    setBusy(true);
    const { error } = await supabase.rpc("put_forward_for_next_assignment", { p_application_id: ending.application_id, p_job_id: jobId });
    setBusy(false);
    if (error) return setError(pipelineError(error, "application"));
    setError(null);
    setPutForward(jobId);
    onSaved();
  }

  const sorted = options && [...options].sort((a, b) =>
    sort === "match" ? b.rank - a.rank : (b.effective_weekly_cents ?? -1) - (a.effective_weekly_cents ?? -1));

  return (
    <div className="plan-panel">
      <form className="row wrap" onSubmit={save}>
        <select aria-label="Plan" value={status} onChange={(e) => setStatus(e.target.value as PlanStatus)}>
          {Object.entries(PLAN_STATUSES).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
        </select>
        <input aria-label="Plan note" placeholder="Note, e.g. wants to stay in Texas; asked for nights" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
        <button disabled={busy}>Save plan</button>
      </form>
      {ending.extension_bonus_cents ? <p className="muted hint">Extension: the current terms include a {dollars(ending.extension_bonus_cents)} extension bonus. Record an extension on the journey once the partner confirms it.</p> : null}
      {error && <p role="alert" className="error">{error}</p>}

      <div className="toolbar">
        <h3>What could come next</h3>
        <label>Sort{" "}
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="match">Best match</option>
            <option value="pay">Highest pay</option>
          </select>
        </label>
      </div>
      <p className="muted hint">Ranked 60% fit (specialty, state, a start that follows {formatDate(ending.assignment_end_on)}) and 40% opportunity score. Putting someone forward creates their application; submitting them to a partner still needs their approval. Strike assignments are labelled: offer them only with the clinician's clear agreement.</p>
      {!sorted && <p className="muted">Loading…</p>}
      {sorted && sorted.length === 0 && <p className="muted">No other open jobs right now.</p>}
      {sorted && sorted.length > 0 && (
        <table className="matches">
          <thead><tr><th>Opening</th><th>Starts</th><th>Weekly</th><th>Fit</th><th>Opportunity</th><th>Why</th><th></th></tr></thead>
          <tbody>
            {sorted.slice(0, 15).map((o) => (
              <tr key={o.job_id}>
                <td>
                  <Link to={`/jobs/${o.job_id}`} navigate={navigate}>{o.title}</Link>
                  <div className="muted">{o.city}, {o.state}</div>
                  {o.is_strike && <span className="stage strike">Strike assignment</span>}
                  {o.is_crisis_rate && <span className="stage priority-high">Crisis rate</span>}
                </td>
                <td>{o.start_date ? formatDate(o.start_date) : "—"}</td>
                <td>
                  {o.effective_weekly_cents ? dollars(o.effective_weekly_cents) : <span className="muted">Not on file</span>}
                  {o.pay_change_pct !== null && <div className={o.pay_change_pct > 0 ? "raise" : "muted"}>{o.pay_change_pct > 0 ? "+" : ""}{o.pay_change_pct}% vs now</div>}
                </td>
                <td><span className={scoreClass(o.fit_score)}>{o.fit_score}</span></td>
                <td><span className={scoreClass(o.opportunity_score)}>{o.opportunity_score}</span></td>
                <td className="muted">{o.fit_reasons.join(" · ")}</td>
                <td>{putForward === o.job_id
                  ? <Link to={`/jobs/${o.job_id}`} navigate={navigate}>Put forward ↗</Link>
                  : <button className="link" disabled={busy} onClick={() => forward(o.job_id)}>Put forward</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
