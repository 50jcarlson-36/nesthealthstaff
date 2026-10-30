// The partner connector on a partner's page: download its submissions, import
// the partner's update file, manage its API keys and see what came in.
// The CSV columns are shared with the partner-api function.

import { type FormEvent, useEffect, useState } from "react";
import {
  csvToUpdates, type ExportedSubmission, type PartnerUpdate, submissionsToCsv,
} from "../../../supabase/functions/_shared/partner-csv.ts";
import type { Partner } from "./partners.tsx";
import { formatDate, label } from "./shared.tsx";
import { supabase } from "./supabase.ts";

type Changes = { stage?: { from: string; to: string }; items?: number; partner_candidate_reference?: string };
type RowResult = { row: number; result: "applied" | "unchanged" | "stale" | "rejected"; error?: string; submission_id?: string; changes?: Changes };
type ImportResult = { dry_run: boolean; counts: Record<RowResult["result"], number>; rows: RowResult[] };
type ApiKey = { id: string; label: string; key_prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null };
type PartnerEvent = { id: number; source: "api" | "csv"; result: RowResult["result"]; error: string | null; changes: Changes; received_at: string };

const API_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/partner-api`;

function describe(changes: Changes | undefined): string {
  if (!changes) return "";
  const parts: string[] = [];
  if (changes.stage) parts.push(`${label(changes.stage.from)} → ${label(changes.stage.to)}`);
  if (changes.items) parts.push(`${changes.items} checklist item${changes.items === 1 ? "" : "s"}`);
  if (changes.partner_candidate_reference) parts.push(`reference ${changes.partner_candidate_reference}`);
  return parts.join(" · ");
}

function outcome(r: { result: RowResult["result"]; error?: string | null; changes?: Changes }): string {
  if (r.result === "rejected") return r.error ?? "Rejected";
  if (r.result === "stale") return "Skipped: older than the stage already recorded";
  if (r.result === "unchanged") return "No change";
  return describe(r.changes);
}

function download(name: string, type: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function PartnerConnector({ partner, isAdmin }: { partner: Partner; isAdmin: boolean }) {
  const [events, setEvents] = useState<PartnerEvent[] | null>(null);
  const loadEvents = () => supabase.from("partner_events").select("id, source, result, error, changes, received_at")
    .eq("partner_id", partner.id).order("received_at", { ascending: false }).limit(20)
    .then(({ data }) => setEvents((data ?? []) as PartnerEvent[]));
  useEffect(() => { loadEvents(); }, [partner.id]);

  const connected = partner.status === "active" || partner.status === "paused";
  return (
    <section className="connector">
      <h2>Connector</h2>
      <p className="muted hint">Send this partner its candidates and bring its progress back: by file, or straight from its ATS through the API.</p>
      <ExportCard partner={partner} />
      {connected ? <ImportCard partner={partner} onImported={loadEvents} />
        : <div className="card"><h3>Import updates</h3><p className="muted">Updates can be imported once the partner is active.</p></div>}
      <ApiKeysCard partner={partner} isAdmin={isAdmin} />
      <div className="card">
        <h3>Recent updates</h3>
        {events && events.length === 0 && <p className="muted">Nothing has come in from this partner yet.</p>}
        {events && events.length > 0 && (
          <ul className="checklist events">
            {events.map((e) => (
              <li key={e.id} className={e.result === "rejected" ? "rejected" : undefined}>
                <span><strong>{e.source === "api" ? "API" : "CSV"}</strong> · {formatDate(e.received_at)} · {label(e.result)}</span>
                <span className="muted">{outcome(e)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ExportCard({ partner }: { partner: Partner }) {
  const [since, setSince] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  async function run(format: "csv" | "json") {
    setBusy(true);
    setMessage(null);
    const { data, error } = await supabase.rpc("export_partner_submissions", {
      p_partner_id: partner.id, p_since: since ? new Date(`${since}T00:00`).toISOString() : null,
    });
    setBusy(false);
    if (error) return setMessage({ error: true, text: "Couldn't build the export. Try again." });
    const submissions = (data as { submissions: ExportedSubmission[] }).submissions;
    if (submissions.length === 0) return setMessage({ error: false, text: "No submissions to export." });
    const base = `nest-${partner.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-submissions-${new Date().toISOString().slice(0, 10)}`;
    if (format === "csv") download(`${base}.csv`, "text/csv;charset=utf-8", submissionsToCsv(submissions));
    else download(`${base}.json`, "application/json", JSON.stringify(data, null, 2));
    setMessage({ error: false, text: `Exported ${submissions.length} submission${submissions.length === 1 ? "" : "s"}.` });
  }

  return (
    <div className="card">
      <h3>Export submissions</h3>
      <p className="muted hint">Candidates you've submitted to this partner, with the opening, stage and checklist. Contact details are left out once a submission is withdrawn; pay terms and internal notes are never included. Each export is logged.</p>
      <div className="row wrap">
        <label className="inline">Changed since <input type="date" value={since} onChange={(e) => setSince(e.target.value)} /></label>
        <button disabled={busy} onClick={() => run("csv")}>Download CSV</button>
        <button disabled={busy} className="secondary" onClick={() => run("json")}>Download JSON</button>
      </div>
      {message && <p role={message.error ? "alert" : "status"} className={message.error ? "error" : "muted"}>{message.text}</p>}
    </div>
  );
}

function ImportCard({ partner, onImported }: { partner: Partner; onImported: () => void }) {
  const [file, setFile] = useState<{ name: string; updates: PartnerUpdate[]; lines: number[]; ignored: string[] } | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inputKey, setInputKey] = useState(0);

  function reset() {
    setFile(null);
    setPreview(null);
    setError(null);
    setInputKey((k) => k + 1);
  }

  async function call(updates: PartnerUpdate[], dryRun: boolean) {
    const { data, error } = await supabase.rpc("import_partner_updates", { p_partner_id: partner.id, p_rows: updates, p_dry_run: dryRun });
    if (error) {
      setError(error.code === "PT400" ? error.message : "Couldn't check the file. Try again.");
      return null;
    }
    return data as ImportResult;
  }

  async function choose(chosen: File | undefined) {
    setDone(null);
    setPreview(null);
    setError(null);
    if (!chosen) return setFile(null);
    if (chosen.size > 2_000_000) return setError("That file is over 2 MB. Split it into smaller files.");
    const parsed = csvToUpdates(await chosen.text());
    if (parsed.error) return setError(parsed.error);
    setFile({ name: chosen.name, updates: parsed.updates, lines: parsed.lines, ignored: parsed.ignoredColumns });
    setBusy(true);
    setPreview(await call(parsed.updates, true));
    setBusy(false);
  }

  async function apply(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const result = await call(file!.updates, false);
    setBusy(false);
    if (!result) return;
    setDone(result);
    reset();
    onImported();
  }

  const shown = done ?? preview;
  const lines = file?.lines ?? [];
  return (
    <form className="card" onSubmit={apply}>
      <h3>Import updates</h3>
      <p className="muted hint">
        A CSV from the partner, one update per row. Each row needs <code>submission_id</code> or <code>partner_candidate_reference</code>,
        plus any of <code>stage</code>, <code>assignment_start_on</code>, <code>assignment_end_on</code>, <code>note</code>, <code>item</code>,{" "}
        <code>item_status</code>, <code>item_owner</code>, <code>item_due_on</code>. The partner can also edit our export and send it back.
        You'll see what each row does before anything changes.
      </p>
      <input key={inputKey} type="file" accept=".csv,text/csv" aria-label="Partner update file" onChange={(e) => choose(e.target.files?.[0])} />
      {busy && <p className="muted">Checking…</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {file && file.ignored.length > 0 && <p className="muted">Ignored columns: {file.ignored.join(", ")}</p>}
      {shown && (
        <>
          <p role="status">
            <strong>{done ? "Imported" : `Preview of ${file?.name}`}:</strong>{" "}
            {shown.counts.applied} {done ? "applied" : "will apply"} · {shown.counts.unchanged} unchanged · {shown.counts.stale} stale · {shown.counts.rejected} rejected
          </p>
          {!done && (
            <table className="import-preview">
              <thead><tr><th>Line</th><th>Result</th><th>What happens</th></tr></thead>
              <tbody>
                {shown.rows.map((r) => (
                  <tr key={r.row} className={r.result === "rejected" ? "rejected" : undefined}>
                    <td>{lines[r.row - 1] ?? r.row}</td><td>{label(r.result)}</td><td>{outcome(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      {preview && !done && (
        <div className="row">
          <button disabled={busy || preview.counts.applied === 0}>
            Apply {preview.counts.applied} update{preview.counts.applied === 1 ? "" : "s"}
          </button>
          <button type="button" className="link" onClick={reset}>Cancel</button>
        </div>
      )}
    </form>
  );
}

function ApiKeysCard({ partner, isAdmin }: { partner: Partner; isAdmin: boolean }) {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [labelText, setLabelText] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => supabase.from("partner_api_keys").select("id, label, key_prefix, created_at, last_used_at, revoked_at")
    .eq("partner_id", partner.id).order("created_at", { ascending: false })
    .then(({ data }) => setKeys((data ?? []) as ApiKey[]));
  useEffect(() => { load(); setCreated(null); }, [partner.id]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error } = await supabase.rpc("create_partner_api_key", { p_partner_id: partner.id, p_label: labelText });
    setBusy(false);
    if (error) return setError(error.code === "PT400" || error.code === "PT403" ? error.message : "Couldn't create the key.");
    setCreated((data as { key: string }).key);
    setLabelText("");
    load();
  }

  async function revoke(id: string) {
    setBusy(true);
    const { error } = await supabase.rpc("revoke_partner_api_key", { p_key_id: id });
    setBusy(false);
    setConfirming(null);
    if (error) return setError(error.code === "PT400" || error.code === "PT403" ? error.message : "Couldn't revoke the key.");
    load();
  }

  return (
    <div className="card">
      <h3>API access</h3>
      <p className="muted hint">
        The partner's ATS can pull submissions from <code>GET {API_URL}/submissions</code> and post progress to{" "}
        <code>POST {API_URL}/events</code>, with <code>Authorization: Bearer &lt;key&gt;</code>. See docs/API.md for the format.
      </p>
      {created && (
        <div className="signin-notice key-once" role="status">
          <strong>Copy this key now. It won't be shown again.</strong>
          <code className="secret">{created}</code>
          <div className="row">
            <button type="button" onClick={() => navigator.clipboard.writeText(created)}>Copy key</button>
            <button type="button" className="link" onClick={() => setCreated(null)}>I've saved it</button>
          </div>
          <p className="muted">Send it to the partner through a secure channel, not plain email.</p>
        </div>
      )}
      {keys && keys.length === 0 && <p className="muted">No keys yet.</p>}
      {keys && keys.length > 0 && (
        <ul className="checklist">
          {keys.map((k) => (
            <li key={k.id} className={k.revoked_at ? "revoked" : undefined}>
              <span>
                <strong>{k.label}</strong> · <code>{k.key_prefix}…</code> · created {formatDate(k.created_at)}
                {" · "}{k.revoked_at ? `revoked ${formatDate(k.revoked_at)}` : k.last_used_at ? `last used ${formatDate(k.last_used_at)}` : "never used"}
              </span>
              {isAdmin && !k.revoked_at && (confirming === k.id
                ? <span className="row"><button type="button" disabled={busy} onClick={() => revoke(k.id)}>Revoke now</button><button type="button" className="link" onClick={() => setConfirming(null)}>Keep</button></span>
                : <button type="button" className="link" onClick={() => setConfirming(k.id)}>Revoke</button>)}
            </li>
          ))}
        </ul>
      )}
      {isAdmin && partner.status === "active" && (
        <form className="row" onSubmit={create}>
          <input aria-label="Key label" placeholder="Label, e.g. Bullhorn integration" maxLength={100} value={labelText} onChange={(e) => setLabelText(e.target.value)} />
          <button disabled={busy}>Create API key</button>
        </form>
      )}
      {isAdmin && partner.status !== "active" && <p className="muted">Keys can be created once the partner is active.</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </div>
  );
}
