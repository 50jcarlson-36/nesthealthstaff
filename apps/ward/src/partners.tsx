// Partner agencies, the partner terms on an opening, and the consent and
// submission controls on each application. Nest submits candidates to a
// partner's openings only with the candidate's approval, and records each
// submission for attribution.

import { type FormEvent, useEffect, useState } from "react";
import { formatDate, label, Link, type Save, useSave } from "./shared.tsx";
import { type Job, type JobApplication, type Membership, pipelineError, supabase } from "./supabase.ts";

type Navigate = (to: string) => void;

export type PartnerStatus = "prospect" | "applying" | "active" | "paused" | "ended";
const PARTNER_STATUSES: PartnerStatus[] = ["prospect", "applying", "active", "paused", "ended"];
const TRANSFER_METHODS = { manual: "Manual", csv: "CSV file", api: "API", ats_export: "ATS export" } as const;

export type Partner = {
  id: string;
  organization_id: string;
  name: string;
  status: PartnerStatus;
  contact_name: string | null;
  contact_email: string | null;
  agreement_signed_on: string | null;
  eligibility_notes: string | null;
  fee_terms: string | null;
  payment_timing: string | null;
  extension_cancellation_terms: string | null;
  attribution_days: number | null;
  duplicate_rules: string | null;
  may_advertise: boolean;
  advertising_terms: string | null;
  data_transfer_method: keyof typeof TRANSFER_METHODS;
  data_transfer_notes: string | null;
  notes: string | null;
  version: number;
};

type PartnerInput = Omit<Partner, "id" | "organization_id" | "version">;

const EMPTY_PARTNER: PartnerInput = {
  name: "", status: "prospect", contact_name: null, contact_email: null, agreement_signed_on: null,
  eligibility_notes: null, fee_terms: null, payment_timing: null, extension_cancellation_terms: null,
  attribution_days: null, duplicate_rules: null, may_advertise: false, advertising_terms: null,
  data_transfer_method: "manual", data_transfer_notes: null, notes: null,
};

export type JobTerms = {
  job_id: string;
  partner_id: string | null;
  partner_reference: string | null;
  priority: "normal" | "high" | "critical";
  is_strike: boolean;
  strike_starts_on: string | null;
  strike_ends_on: string | null;
  strike_union: string | null;
  strike_notes: string | null;
  hourly_rate_cents: number | null;
  weekly_gross_cents: number | null;
  housing_stipend_weekly_cents: number | null;
  meals_stipend_weekly_cents: number | null;
  is_crisis_rate: boolean;
  sign_on_bonus_cents: number | null;
  completion_bonus_cents: number | null;
  extension_bonus_cents: number | null;
  referral_bonus_cents: number | null;
  nest_incentive_cents: number | null;
  incentive_notes: string | null;
};

export const EMPTY_TERMS: Omit<JobTerms, "job_id"> = {
  partner_id: null, partner_reference: null, priority: "normal", is_strike: false, strike_starts_on: null,
  strike_ends_on: null, strike_union: null, strike_notes: null, hourly_rate_cents: null, weekly_gross_cents: null,
  housing_stipend_weekly_cents: null, meals_stipend_weekly_cents: null, is_crisis_rate: false,
  sign_on_bonus_cents: null, completion_bonus_cents: null, extension_bonus_cents: null,
  referral_bonus_cents: null, nest_incentive_cents: null, incentive_notes: null,
};

export type Consent = {
  id: string;
  application_id: string;
  partner_id: string;
  status: "pending" | "granted" | "declined" | "expired" | "revoked";
  includes_strike: boolean;
  consent_version: string;
  requested_at: string;
  expires_at: string;
  responded_at: string | null;
};

export type PartnerSubmission = {
  id: string;
  application_id: string;
  partner_id: string;
  status: "submitted" | "partner_duplicate" | "withdrawn";
  partner_candidate_reference: string | null;
  submitted_at: string;
  attribution_expires_on: string;
  status_reason: string | null;
  version: number;
};

// --- Money ---------------------------------------------------------------------

export function dollars(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: cents % 100 ? 2 : 0 });
}

function toCents(value: string): number | null {
  const n = Number(value.replace(/[$,\s]/g, ""));
  return value.trim() === "" || !Number.isFinite(n) ? null : Math.round(n * 100);
}

const optional = (v: string) => (v.trim() === "" ? null : v);

// --- Partner list and detail ---------------------------------------------------------

export function PartnerList({ navigate, memberships }: { navigate: Navigate; memberships: Membership[] }) {
  const [rows, setRows] = useState<Partner[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const adminOrg = memberships.find((m) => m.role === "admin")?.organization_id;

  useEffect(() => {
    supabase.from("partners").select("*").order("name").then(({ data, error }) => {
      if (error) setError("Couldn't load partners.");
      else setRows(data as Partner[]);
    });
  }, []);

  async function create(input: PartnerInput) {
    const { data, error } = await supabase.rpc("create_partner", { p_organization_id: adminOrg, p_partner: input });
    if (error) return pipelineError(error, "partner");
    navigate(`/partners/${(data as { id: string }).id}`);
    return null;
  }

  return (
    <section>
      <div className="page-intro"><div><p className="eyebrow">RECRUITING PARTNERS</p><h1>The agencies we submit to.</h1><p className="muted">Each partner's terms, advertising permission and attribution period.</p></div></div>
      <div className="toolbar">
        <h2>Partners</h2>
        {adminOrg && !adding && <button onClick={() => setAdding(true)}>Add partner</button>}
      </div>
      {adding && adminOrg && <PartnerForm initial={EMPTY_PARTNER} submitLabel="Add partner" onSubmit={create} onCancel={() => setAdding(false)} />}
      {error && <p role="alert" className="error">{error}</p>}
      {!rows && !error && <p className="muted">Loading…</p>}
      {rows && rows.length === 0 && !adding && <p className="muted">No partners yet.{adminOrg ? " Add one when an agency agrees to work with Nest." : ""}</p>}
      {rows && rows.length > 0 && (
        <table>
          <thead><tr><th>Partner</th><th>Status</th><th>Advertising</th><th>Attribution</th><th>Transfer</th></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td><Link to={`/partners/${p.id}`} navigate={navigate}>{p.name}</Link></td>
                <td><span className={`stage partner-${p.status}`}>{label(p.status)}</span></td>
                <td>{p.may_advertise ? "Allowed" : <span className="muted">Not allowed</span>}</td>
                <td>{p.attribution_days ? `${p.attribution_days} days` : <span className="muted">Not set</span>}</td>
                <td>{TRANSFER_METHODS[p.data_transfer_method]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function PartnerDetail({ id, navigate, memberships }: { id: string; navigate: Navigate; memberships: Membership[] }) {
  const [partner, setPartner] = useState<Partner | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);

  const load = () => supabase.from("partners").select("*").eq("id", id).maybeSingle().then(({ data }) => setPartner(data as Partner | null));
  useEffect(() => { setPartner(undefined); setEditing(false); load(); }, [id]);

  const back = <Link to="/partners" navigate={navigate}>← Partners</Link>;
  if (partner === undefined) return <p className="muted">Loading…</p>;
  if (partner === null) return <>{back}<p>Partner not found, or you don't have access to it.</p></>;
  const isAdmin = memberships.some((m) => m.role === "admin" && m.organization_id === partner.organization_id);

  async function update(input: PartnerInput) {
    const { error } = await supabase.rpc("update_partner", { p_partner_id: partner!.id, p_expected_version: partner!.version, p_partner: input });
    if (error) {
      if (error.code === "PT409") await load();
      return pipelineError(error, "partner");
    }
    setEditing(false);
    await load();
    return null;
  }

  const text = (title: string, value: string | null) => value && <><h3>{title}</h3><p className="note-body">{value}</p></>;
  return (
    <article>
      {back}
      <div className="detail-head"><h1>{partner.name}</h1><span className={`stage partner-${partner.status}`}>{label(partner.status)}</span></div>
      {editing ? (
        <PartnerForm key={partner.version} initial={partner} submitLabel="Save changes" onSubmit={update} onCancel={() => setEditing(false)} />
      ) : (
        <>
          {isAdmin && <p><button onClick={() => setEditing(true)}>Edit partner</button></p>}
          <div className="card">
            <dl className="fields">
              <div><dt>Contact</dt><dd>{[partner.contact_name, partner.contact_email].filter(Boolean).join(" · ") || "—"}</dd></div>
              <div><dt>Agreement signed</dt><dd>{partner.agreement_signed_on ? formatDate(partner.agreement_signed_on) : "—"}</dd></div>
              <div><dt>Attribution period</dt><dd>{partner.attribution_days ? `${partner.attribution_days} days` : "Not set: submissions are blocked"}</dd></div>
              <div><dt>Advertising on our site</dt><dd>{partner.may_advertise ? "Allowed" : "Not allowed: openings stay internal"}</dd></div>
              <div><dt>Candidate transfer</dt><dd>{TRANSFER_METHODS[partner.data_transfer_method]}</dd></div>
            </dl>
            {text("Eligibility", partner.eligibility_notes)}
            {text("Placement fee", partner.fee_terms)}
            {text("Payment timing", partner.payment_timing)}
            {text("Extensions, cancellations and refunds", partner.extension_cancellation_terms)}
            {text("Duplicate-submission rules", partner.duplicate_rules)}
            {text("Advertising terms and branding", partner.advertising_terms)}
            {text("Transfer details", partner.data_transfer_notes)}
            {text("Notes", partner.notes)}
          </div>
        </>
      )}
    </article>
  );
}

function PartnerForm({ initial, submitLabel, onSubmit, onCancel }: {
  initial: PartnerInput;
  submitLabel: string;
  onSubmit: (input: PartnerInput) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [v, setV] = useState<PartnerInput>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof PartnerInput>(k: K, value: PartnerInput[K]) => setV((old) => ({ ...old, [k]: value }));
  const area = (k: keyof PartnerInput, title: string, hint?: string) => (
    <div className="field wide">
      <label htmlFor={`partner-${k}`}>{title}</label>
      <textarea id={`partner-${k}`} rows={3} maxLength={2000} placeholder={hint} value={(v[k] as string | null) ?? ""} onChange={(e) => set(k, optional(e.target.value) as never)} />
    </div>
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(await onSubmit(v));
    setSaving(false);
  }

  return (
    <form className="card job-form" onSubmit={submit}>
      <div className="grid">
        <div className="field"><label htmlFor="partner-name">Name</label><input id="partner-name" required maxLength={200} value={v.name} onChange={(e) => set("name", e.target.value)} /></div>
        <div className="field">
          <label htmlFor="partner-status">Status</label>
          <select id="partner-status" value={v.status} onChange={(e) => set("status", e.target.value as PartnerStatus)}>
            {PARTNER_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
          </select>
        </div>
        <div className="field"><label htmlFor="partner-signed">Agreement signed on</label><input id="partner-signed" type="date" value={v.agreement_signed_on ?? ""} onChange={(e) => set("agreement_signed_on", optional(e.target.value))} /></div>
        <div className="field"><label htmlFor="partner-contact">Contact name</label><input id="partner-contact" maxLength={160} value={v.contact_name ?? ""} onChange={(e) => set("contact_name", optional(e.target.value))} /></div>
        <div className="field"><label htmlFor="partner-email">Contact email</label><input id="partner-email" type="email" maxLength={254} value={v.contact_email ?? ""} onChange={(e) => set("contact_email", optional(e.target.value))} /></div>
        <div className="field"><label htmlFor="partner-attribution">Attribution period (days)</label><input id="partner-attribution" type="number" min={1} max={730} value={v.attribution_days ?? ""} onChange={(e) => set("attribution_days", e.target.value ? Number(e.target.value) : null)} /></div>
        <div className="field">
          <label htmlFor="partner-transfer">Candidate transfer</label>
          <select id="partner-transfer" value={v.data_transfer_method} onChange={(e) => set("data_transfer_method", e.target.value as Partner["data_transfer_method"])}>
            {Object.entries(TRANSFER_METHODS).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="partner-ads">Advertising on our site</label>
          <select id="partner-ads" value={v.may_advertise ? "yes" : "no"} onChange={(e) => set("may_advertise", e.target.value === "yes")}>
            <option value="no">Not allowed</option>
            <option value="yes">Allowed in writing</option>
          </select>
        </div>
        {area("advertising_terms", "Advertising terms and branding", "Required before allowing advertising: what the written permission says.")}
        {area("eligibility_notes", "Eligibility and application process")}
        {area("fee_terms", "Placement fee")}
        {area("payment_timing", "Payment timing")}
        {area("extension_cancellation_terms", "Extensions, cancellations and refunds")}
        {area("duplicate_rules", "Duplicate-submission rules")}
        {area("data_transfer_notes", "Transfer details (API, XML, CSV, ATS)")}
        {area("notes", "Notes")}
      </div>
      <p className="muted hint">A partner can be active only with an agreement date. Candidates can be submitted only once the attribution period is set.</p>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="row"><button type="submit" disabled={saving}>{saving ? "Saving…" : submitLabel}</button><button type="button" className="link" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

// --- Partner terms on an opening -------------------------------------------------------

export function JobTermsCard({ job, terms, partners, save }: { job: Job; terms: JobTerms | null; partners: Partner[]; save: Save }) {
  const [editing, setEditing] = useState(false);
  const t = terms ?? { job_id: job.id, ...EMPTY_TERMS };
  const partner = partners.find((p) => p.id === t.partner_id);
  const money: [string, number | null][] = [
    ["Hourly rate", t.hourly_rate_cents], ["Weekly gross", t.weekly_gross_cents],
    ["Housing stipend / week", t.housing_stipend_weekly_cents], ["Meals stipend / week", t.meals_stipend_weekly_cents],
    ["Sign-on bonus", t.sign_on_bonus_cents], ["Completion bonus", t.completion_bonus_cents],
    ["Extension bonus", t.extension_bonus_cents], ["Referral bonus", t.referral_bonus_cents],
    ["Nest incentive", t.nest_incentive_cents],
  ];

  if (editing) {
    return <JobTermsForm key={job.version} job={job} initial={t} partners={partners} save={save} onDone={() => setEditing(false)} />;
  }
  return (
    <div className="card internal">
      <div className="toolbar">
        <h3>Partner and pay</h3>
        {t.is_strike && <span className="stage strike">Strike assignment</span>}
        {t.priority !== "normal" && <span className={`stage priority-${t.priority}`}>{label(t.priority)} priority</span>}
        <button onClick={() => setEditing(true)}>Edit terms</button>
      </div>
      <dl className="fields">
        <div><dt>Partner</dt><dd>{partner ? `${partner.name}${partner.status === "active" ? "" : ` (${partner.status})`}` : "Direct (no partner)"}</dd></div>
        {t.partner_reference && <div><dt>Partner's reference</dt><dd>{t.partner_reference}</dd></div>}
        {partner && <div><dt>On our job board</dt><dd>{partner.status === "active" && partner.may_advertise ? "Yes, when open" : "No: no advertising permission"}</dd></div>}
        {t.is_strike && <div><dt>Strike dates</dt><dd>{[t.strike_starts_on && formatDate(t.strike_starts_on), t.strike_ends_on && formatDate(t.strike_ends_on)].filter(Boolean).join(" to ") || "Not given"}</dd></div>}
        {t.strike_union && <div><dt>Union</dt><dd>{t.strike_union}</dd></div>}
        {money.filter(([, c]) => c !== null).map(([k, c]) => <div key={k}><dt>{k}</dt><dd>{dollars(c)}</dd></div>)}
        {t.is_crisis_rate && <div><dt>Rate type</dt><dd>Crisis rate</dd></div>}
      </dl>
      {t.strike_notes && <><h3>Strike notes</h3><p className="note-body">{t.strike_notes}</p></>}
      {t.incentive_notes && <><h3>Incentive notes</h3><p className="note-body">{t.incentive_notes}</p></>}
    </div>
  );
}

function JobTermsForm({ job, initial, partners, save, onDone }: { job: Job; initial: JobTerms; partners: Partner[]; save: Save; onDone: () => void }) {
  const [v, setV] = useState(initial);
  const [amounts, setAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(initial).filter(([k]) => k.endsWith("_cents")).map(([k, c]) => [k, c === null ? "" : String((c as number) / 100)])),
  );
  const { saving, error, run } = useSave(save);
  const set = <K extends keyof JobTerms>(k: K, value: JobTerms[K]) => setV((old) => ({ ...old, [k]: value }));
  const amount = (k: string, title: string) => (
    <div className="field">
      <label htmlFor={`terms-${k}`}>{title} ($)</label>
      <input id={`terms-${k}`} inputMode="decimal" value={amounts[k] ?? ""} onChange={(e) => setAmounts((a) => ({ ...a, [k]: e.target.value }))} />
    </div>
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    const { job_id: _job, ...rest } = v;
    const cents = Object.fromEntries(Object.entries(amounts).map(([k, s]) => [k, toCents(s)]));
    const strikeOff = rest.is_strike ? {} : { strike_starts_on: null, strike_ends_on: null, strike_union: null };
    if (await run(() => supabase.rpc("set_job_terms", { p_job_id: job.id, p_expected_version: job.version, p_terms: { ...rest, ...cents, ...strikeOff } }))) onDone();
  }

  return (
    <form className="card internal job-form" onSubmit={submit}>
      <h3>Partner and pay</h3>
      <div className="grid">
        <div className="field">
          <label htmlFor="terms-partner">Partner</label>
          <select id="terms-partner" value={v.partner_id ?? ""} onChange={(e) => set("partner_id", e.target.value || null)}>
            <option value="">Direct (no partner)</option>
            {partners.map((p) => <option key={p.id} value={p.id}>{p.name}{p.status === "active" ? "" : ` (${p.status})`}</option>)}
          </select>
        </div>
        <div className="field"><label htmlFor="terms-ref">Partner's reference</label><input id="terms-ref" maxLength={100} value={v.partner_reference ?? ""} onChange={(e) => set("partner_reference", optional(e.target.value))} /></div>
        <div className="field">
          <label htmlFor="terms-priority">Priority</label>
          <select id="terms-priority" value={v.priority} onChange={(e) => set("priority", e.target.value as JobTerms["priority"])}>
            <option value="normal">Normal</option><option value="high">High</option><option value="critical">Critical</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="terms-strike">Strike assignment</label>
          <select id="terms-strike" value={v.is_strike ? "yes" : "no"} onChange={(e) => set("is_strike", e.target.value === "yes")}>
            <option value="no">No</option><option value="yes">Yes: labelled everywhere</option>
          </select>
        </div>
        {v.is_strike && (
          <>
            <div className="field"><label htmlFor="terms-strike-start">Strike starts</label><input id="terms-strike-start" type="date" value={v.strike_starts_on ?? ""} onChange={(e) => set("strike_starts_on", optional(e.target.value))} /></div>
            <div className="field"><label htmlFor="terms-strike-end">Strike ends</label><input id="terms-strike-end" type="date" value={v.strike_ends_on ?? ""} onChange={(e) => set("strike_ends_on", optional(e.target.value))} /></div>
            <div className="field"><label htmlFor="terms-union">Union</label><input id="terms-union" maxLength={200} value={v.strike_union ?? ""} onChange={(e) => set("strike_union", optional(e.target.value))} /></div>
            <div className="field wide"><label htmlFor="terms-strike-notes">Strike notes</label><textarea id="terms-strike-notes" rows={2} maxLength={2000} value={v.strike_notes ?? ""} onChange={(e) => set("strike_notes", optional(e.target.value))} /></div>
          </>
        )}
        {amount("hourly_rate_cents", "Hourly rate")}
        {amount("weekly_gross_cents", "Weekly gross")}
        {amount("housing_stipend_weekly_cents", "Housing stipend / week")}
        {amount("meals_stipend_weekly_cents", "Meals stipend / week")}
        <div className="field">
          <label htmlFor="terms-crisis">Rate type</label>
          <select id="terms-crisis" value={v.is_crisis_rate ? "yes" : "no"} onChange={(e) => set("is_crisis_rate", e.target.value === "yes")}>
            <option value="no">Standard</option><option value="yes">Crisis rate</option>
          </select>
        </div>
        {amount("sign_on_bonus_cents", "Sign-on bonus")}
        {amount("completion_bonus_cents", "Completion bonus")}
        {amount("extension_bonus_cents", "Extension bonus")}
        {amount("referral_bonus_cents", "Referral bonus")}
        {amount("nest_incentive_cents", "Nest incentive")}
        <div className="field wide"><label htmlFor="terms-incentive-notes">Incentive notes</label><textarea id="terms-incentive-notes" rows={2} maxLength={2000} value={v.incentive_notes ?? ""} onChange={(e) => set("incentive_notes", optional(e.target.value))} /></div>
      </div>
      <p className="muted hint">Pay and incentives stay internal. Only the strike label appears on the public job board.</p>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="row"><button type="submit" disabled={saving}>{saving ? "Saving…" : "Save terms"}</button><button type="button" className="link" onClick={onDone}>Cancel</button></div>
    </form>
  );
}

// --- Consent and submission on an application ---------------------------------------------

export function SubmissionPanel({ application: a, terms, partner, consents, submission, save }: {
  application: JobApplication;
  terms: JobTerms | null;
  partner: Partner | undefined;
  consents: Consent[];
  submission: PartnerSubmission | undefined;
  save: Save;
}) {
  const { saving, error, run } = useSave(save);
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  if (!terms?.partner_id || !partner) return null;

  const latest = consents.filter((c) => c.partner_id === partner.id).sort((x, y) => y.requested_at.localeCompare(x.requested_at))[0];
  const granted = latest?.status === "granted" && (!terms.is_strike || latest.includes_strike);
  const closed = ["rejected", "withdrawn", "hired"].includes(a.stage);

  if (submission && submission.status !== "withdrawn") {
    return (
      <div className="action submission">
        <p>Submitted to {partner.name} {formatDate(submission.submitted_at)}{submission.partner_candidate_reference ? ` · their ref ${submission.partner_candidate_reference}` : ""}</p>
        <p>Attribution until {formatDate(submission.attribution_expires_on)}{submission.status === "partner_duplicate" ? ` · Partner reported a duplicate: ${submission.status_reason}` : ""}</p>
        {submission.status === "submitted" && (
          <form className="row" onSubmit={(e) => { e.preventDefault(); }}>
            <input aria-label="Reason" placeholder="Reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            {(["withdrawn", "partner_duplicate"] as const).map((s) => (
              <button key={s} type="button" className="link" disabled={saving || !reason.trim()}
                onClick={() => run(() => supabase.rpc("update_partner_submission", { p_submission_id: submission.id, p_expected_version: submission.version, p_status: s, p_reason: reason }))}>
                {s === "withdrawn" ? "Withdraw" : "Partner had them"}
              </button>
            ))}
          </form>
        )}
        {error && <p role="alert" className="error">{error}</p>}
      </div>
    );
  }

  const consentLine = !latest
    ? "Not asked yet."
    : latest.status === "pending"
    ? `Asked ${formatDate(latest.requested_at)}; waiting for an answer until ${formatDate(latest.expires_at)}.`
    : latest.status === "granted"
    ? `Approved ${formatDate(latest.responded_at!)}${latest.includes_strike ? ", including strike work" : ""}.`
    : `${label(latest.status)}${latest.responded_at ? ` ${formatDate(latest.responded_at)}` : ""}.`;

  return (
    <div className="action submission">
      <p>{partner.name}: candidate approval. {consentLine}</p>
      {terms.is_strike && latest?.status === "granted" && !latest.includes_strike && <p className="error">This became a strike assignment after they approved. Ask again.</p>}
      {!partner.attribution_days && <p className="error">Set {partner.name}'s attribution period before submitting.</p>}
      {partner.status !== "active" && <p className="error">{partner.name} isn't active, so candidates can't be submitted.</p>}
      {!closed && partner.status === "active" && (
        <div className="row">
          {latest?.status === "pending" ? (
            <button type="button" className="link" disabled={saving} onClick={() => run(() => supabase.rpc("revoke_submission_consent", { p_consent_id: latest.id }))}>Cancel request</button>
          ) : null}
          {!granted && (
            <button type="button" disabled={saving} onClick={() => run(() => supabase.rpc("request_submission_consent", { p_application_id: a.id }))}>
              {latest ? "Ask again" : "Ask for approval"}
            </button>
          )}
          {granted && partner.attribution_days && (
            <>
              <input aria-label="Partner's candidate reference" placeholder="Their candidate ref (optional)" maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} />
              <button type="button" disabled={saving} onClick={() => run(() => supabase.rpc("submit_to_partner", { p_application_id: a.id, p_partner_candidate_reference: reference || null }))}>
                Record submission
              </button>
            </>
          )}
        </div>
      )}
      {error && <p role="alert" className="error">{error}</p>}
    </div>
  );
}
