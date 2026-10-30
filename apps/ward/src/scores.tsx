// Nest's opportunity score on a job, and the openings that fit a clinician
// inquiry. Scores and reasons are computed in the database
// (opportunity_scores, matching_openings); this only shows them.

import { useEffect, useState } from "react";
import { dollars } from "./partners.tsx";
import { formatDate, Link } from "./shared.tsx";
import { supabase } from "./supabase.ts";

type Navigate = (to: string) => void;

export type OpportunityScore = {
  job_id: string;
  score: number;
  need_score: number;
  pay_score: number;
  incentive_score: number;
  need_reasons: string[];
  pay_reason: string;
  incentive_reasons: string[];
  suggestion: string | null;
  is_strike: boolean;
  is_crisis_rate: boolean;
  effective_weekly_cents: number | null;
  median_weekly_cents: number | null;
};

type Match = {
  job_id: string;
  title: string;
  specialty: string;
  city: string;
  state: string;
  start_date: string | null;
  is_strike: boolean;
  is_crisis_rate: boolean;
  effective_weekly_cents: number | null;
  pay_vs_median_pct: number | null;
  opportunity_score: number;
  fit_score: number;
  fit_reasons: string[];
  rank: number;
};

export function scoreClass(score: number): string {
  return score >= 60 ? "score high" : score >= 35 ? "score mid" : "score low";
}

export function OpportunityCard({ jobId }: { jobId: string }) {
  const [s, setS] = useState<OpportunityScore | null | undefined>(undefined);
  useEffect(() => {
    supabase.from("opportunity_scores").select("*").eq("job_id", jobId).maybeSingle().then(({ data }) => setS(data as OpportunityScore | null));
  }, [jobId]);

  if (s === undefined) return null;
  return (
    <>
      <h2>Opportunity score</h2>
      <div className="card opportunity">
        {s === null ? <p className="muted">Scored once the job is open.</p> : (
          <>
            <div className="score-head">
              <span className={scoreClass(s.score)}>{s.score}</span>
              <div>
                <p><strong>Out of 100.</strong> How strongly to push this opening: need, pay and incentives.</p>
                {s.is_strike && <p className="stage strike">Strike assignment: flagged, never promoted by the score</p>}
              </div>
            </div>
            <dl className="score-parts">
              <Part name="Need" value={s.need_score} max={40} reasons={s.need_reasons.length ? s.need_reasons : ["Normal priority, nothing urgent"]} />
              <Part name="Pay" value={s.pay_score} max={40}
                reasons={[s.pay_reason, ...(s.effective_weekly_cents ? [`${dollars(s.effective_weekly_cents)} a week with bonuses spread over the assignment${s.median_weekly_cents ? `; median ${dollars(s.median_weekly_cents)}` : ""}`] : [])]} />
              <Part name="Incentives" value={s.incentive_score} max={20} reasons={s.incentive_reasons.length ? s.incentive_reasons : ["None on file"]} />
            </dl>
            {s.suggestion && <p className="suggestion" role="note">{s.suggestion}</p>}
          </>
        )}
      </div>
    </>
  );
}

function Part({ name, value, max, reasons }: { name: string; value: number; max: number; reasons: string[] }) {
  return (
    <div>
      <dt>{name} <span className="muted">{value}/{max}</span></dt>
      <dd><meter min={0} max={max} value={value} aria-label={`${name} ${value} of ${max}`} /></dd>
      <dd className="muted">{reasons.join(" · ")}</dd>
    </div>
  );
}

export function MatchingOpenings({ inquiryId, navigate }: { inquiryId: string; navigate: Navigate }) {
  const [rows, setRows] = useState<Match[] | null>(null);
  const [error, setError] = useState(false);
  const [sort, setSort] = useState<"match" | "pay">("match");

  useEffect(() => {
    setRows(null);
    supabase.rpc("matching_openings", { p_inquiry_id: inquiryId }).then(({ data, error }) => {
      setError(Boolean(error));
      setRows((data ?? []) as Match[]);
    });
  }, [inquiryId]);

  const sorted = rows && [...rows].sort((a, b) =>
    sort === "match" ? b.rank - a.rank : (b.effective_weekly_cents ?? -1) - (a.effective_weekly_cents ?? -1));

  return (
    <>
      <div className="toolbar">
        <h2>Matching openings</h2>
        <label>Sort{" "}
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="match">Best match</option>
            <option value="pay">Highest pay (wage options)</option>
          </select>
        </label>
      </div>
      <p className="muted hint">Rank = 60% fit (specialty, location, timing, housing) and 40% opportunity score. Strike assignments are labelled: offer them only with the clinician's clear agreement, and the partner's consent request will name the strike.</p>
      {error && <p role="alert" className="error">Couldn't load matching openings.</p>}
      {sorted && sorted.length === 0 && <p className="muted">No open jobs yet.</p>}
      {sorted && sorted.length > 0 && (
        <table className="matches">
          <thead><tr><th>Opening</th><th>Starts</th><th>Weekly</th><th>Fit</th><th>Opportunity</th><th>Why</th></tr></thead>
          <tbody>
            {sorted.map((m) => (
              <tr key={m.job_id}>
                <td>
                  <Link to={`/jobs/${m.job_id}`} navigate={navigate}>{m.title}</Link>
                  <div className="muted">{m.city}, {m.state}</div>
                  {m.is_strike && <span className="stage strike">Strike assignment</span>}
                  {m.is_crisis_rate && <span className="stage priority-high">Crisis rate</span>}
                </td>
                <td>{m.start_date ? formatDate(m.start_date) : "—"}</td>
                <td>
                  {m.effective_weekly_cents ? dollars(m.effective_weekly_cents) : <span className="muted">Not on file</span>}
                  {m.pay_vs_median_pct !== null && <div className="muted">{m.pay_vs_median_pct >= 0 ? "+" : ""}{m.pay_vs_median_pct}% vs median</div>}
                </td>
                <td><span className={scoreClass(m.fit_score)}>{m.fit_score}</span></td>
                <td><span className={scoreClass(m.opportunity_score)}>{m.opportunity_score}</span></td>
                <td className="muted">{m.fit_reasons.join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
