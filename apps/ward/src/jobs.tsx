import { EmptyState } from "./brand.tsx";
// Jobs entered by recruiters, and the applications against them. Public and
// internal fields are edited side by side but stored apart; only the public
// ones ever reach the job board.

import { type FormEvent, useEffect, useState } from "react";
import { formatDate, label, Link, type Save, type StaffDirectory, staffName, useSave } from "./shared.tsx";
import { type Consent, JobTermsCard, type JobTerms, type Partner, SubmissionPanel } from "./partners.tsx";
import { type JourneyItem, JourneyPanel, type JourneySubmission } from "./journeys.tsx";
import {
  APPLICATION_STAGES,
  type ApplicationStage,
  EMPLOYMENT_TYPES,
  type InquirySummary,
  type Job,
  type JobApplication,
  type JobEvent,
  type JobInternal,
  JOB_SOURCES,
  JOB_STATUSES,
  type JobPublic,
  type JobStatus,
  type Membership,
  pipelineError,
  SHIFTS,
  STAGES_WITH_REASON,
  supabase,
} from "./supabase.ts";

type Navigate = (to: string) => void;

const EMPLOYMENT_LABELS: Record<string, string> = {
  travel: "Travel",
  local_contract: "Local contract",
  per_diem: "Per diem",
  permanent: "Permanent",
};
const SOURCE_LABELS: Record<string, string> = { direct_contract: "Direct facility contract", vms: "VMS", other: "Other" };

// --- Job list ----------------------------------------------------------------

type JobRow = Job & {
  job_internal_details: { facility_name: string } | null;
  job_applications: { count: number }[];
};

export function JobList({ navigate }: { navigate: Navigate }) {
  const [status, setStatus] = useState<JobStatus | "active" | "all">("active");
  const [rows, setRows] = useState<JobRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRows(null);
    let query = supabase
      .from("jobs")
      .select("id, organization_id, status, title, specialty, employment_type, city, state, openings, start_date, published_at, version, created_at, job_internal_details(facility_name), job_applications(count)")
      .order("created_at", { ascending: false })
      .limit(200);
    if (status === "active") query = query.in("status", ["draft", "open", "on_hold"]);
    else if (status !== "all") query = query.eq("status", status);
    query.then(({ data, error }) => {
      if (error) setError("Couldn't load jobs.");
      else {
        setError(null);
        setRows(data as unknown as JobRow[]);
      }
    });
  }, [status]);

  return (
    <section>
      <div className="page-intro"><div><p className="eyebrow">MAKE ROOM FOR WHAT’S NEXT</p><h1>Good work. A better fit.</h1><p className="muted">Manage your openings and the people moving toward them.</p></div></div>
      <div className="toolbar">
        <h2>Opportunities</h2>
        <label>
          Status{" "}
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="active">Draft, open or on hold</option>
            <option value="all">All</option>
            {JOB_STATUSES.map((s) => (
              <option key={s} value={s}>{label(s)}</option>
            ))}
          </select>
        </label>
        <button onClick={() => navigate("/jobs/new")}>New job</button>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      {!rows && !error && <p className="muted">Loading…</p>}
      {rows && rows.length === 0 && <EmptyState title="Your next opportunity starts here." description="Create an authorized job order to begin matching nurses with their next chapter."><button onClick={()=>navigate("/jobs/new")}>Create an opportunity</button></EmptyState>}
      {rows && rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Facility (internal)</th>
              <th>Location</th>
              <th>Type</th>
              <th>Start</th>
              <th>Applications</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((j) => (
              <tr key={j.id}>
                <td><Link to={`/jobs/${j.id}`} navigate={navigate}>{j.title}</Link></td>
                <td>{j.job_internal_details?.facility_name}</td>
                <td>{j.city}, {j.state}</td>
                <td>{EMPLOYMENT_LABELS[j.employment_type]}</td>
                <td>{j.start_date && formatDate(j.start_date)}</td>
                <td>{j.job_applications[0]?.count ?? 0}</td>
                <td><span className={`stage job-${j.status}`}>{label(j.status)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// --- Job form ----------------------------------------------------------------

const EMPTY_PUBLIC: JobPublic = {
  title: "", specialty: "", employment_type: "travel", city: "", state: "", shift: null,
  hours_per_week: null, start_date: null, duration_weeks: null, openings: 1, public_description: null,
};
const EMPTY_INTERNAL: JobInternal = {
  facility_name: "", facility_contact: null, source: "direct_contract",
  requisition_reference: null, rate_notes: null, internal_notes: null,
};

function JobForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  children,
}: {
  initial: { pub: JobPublic; internal: JobInternal };
  submitLabel: string;
  onSubmit: (pub: JobPublic, internal: JobInternal) => Promise<string | null>;
  onCancel: () => void;
  children?: React.ReactNode;
}) {
  const [pub, setPub] = useState(initial.pub);
  const [internal, setInternal] = useState(initial.internal);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const text = (v: string) => v;
  const optional = (v: string) => (v === "" ? null : v);
  const number = (v: string) => (v === "" ? null : Number(v));
  function p<K extends keyof JobPublic>(key: K, parse: (v: string) => JobPublic[K]) {
    return {
      id: `job-${key}`,
      value: (pub[key] ?? "") as string | number,
      onChange: (e: { target: { value: string } }) => setPub({ ...pub, [key]: parse(e.target.value) }),
    };
  }
  function i<K extends keyof JobInternal>(key: K, parse: (v: string) => JobInternal[K]) {
    return {
      id: `job-${key}`,
      value: (internal[key] ?? "") as string,
      onChange: (e: { target: { value: string } }) => setInternal({ ...internal, [key]: parse(e.target.value) }),
    };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(await onSubmit(pub, internal));
    setSaving(false);
  }

  return (
    <form className="job-form" onSubmit={submit}>
      {children}
      <fieldset className="card">
        <legend>Public listing</legend>
        <p className="muted hint">Shown on the job board while the job is open.</p>
        <div className="grid">
          <div className="field wide"><label htmlFor="job-title">Title</label><input required maxLength={120} placeholder="Travel RN, Telemetry" {...p("title", text)} /></div>
          <div className="field"><label htmlFor="job-specialty">Specialty</label><input required maxLength={80} {...p("specialty", text)} /></div>
          <div className="field">
            <label htmlFor="job-employment_type">Employment type</label>
            <select {...p("employment_type", (v) => v as JobPublic["employment_type"])}>
              {EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{EMPLOYMENT_LABELS[t]}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor="job-city">City</label><input required maxLength={100} {...p("city", text)} /></div>
          <div className="field"><label htmlFor="job-state">State</label><input required maxLength={2} pattern="[A-Za-z]{2}" placeholder="TX" {...p("state", (v) => v.toUpperCase())} /></div>
          <div className="field">
            <label htmlFor="job-shift">Shift</label>
            <select {...p("shift", (v) => optional(v) as JobPublic["shift"])}>
              <option value="">Not set</option>
              {SHIFTS.map((s) => <option key={s} value={s}>{label(s)}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor="job-hours_per_week">Hours per week</label><input type="number" min={1} max={84} {...p("hours_per_week", number)} /></div>
          <div className="field"><label htmlFor="job-start_date">Start date</label><input type="date" {...p("start_date", optional)} /></div>
          <div className="field"><label htmlFor="job-duration_weeks">Duration (weeks)</label><input type="number" min={1} max={104} {...p("duration_weeks", number)} /></div>
          <div className="field"><label htmlFor="job-openings">Openings</label><input type="number" required min={1} max={100} {...p("openings", (v) => Number(v))} /></div>
          <div className="field wide">
            <label htmlFor="job-public_description">Public description</label>
            <textarea rows={5} maxLength={4000} placeholder="What the role involves. Leave out the facility name and pay unless the contract allows publishing them." {...p("public_description", optional)} />
          </div>
        </div>
      </fieldset>

      <fieldset className="card internal">
        <legend>Internal only</legend>
        <p className="muted hint">Staff only. Never published.</p>
        <div className="grid">
          <div className="field"><label htmlFor="job-facility_name">Facility</label><input required maxLength={200} {...i("facility_name", text)} /></div>
          <div className="field"><label htmlFor="job-facility_contact">Facility contact</label><input maxLength={300} {...i("facility_contact", optional)} /></div>
          <div className="field">
            <label htmlFor="job-source">Source</label>
            <select {...i("source", (v) => v as JobInternal["source"])}>
              {JOB_SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABELS[s]}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor="job-requisition_reference">Requisition reference</label><input maxLength={100} {...i("requisition_reference", optional)} /></div>
          <div className="field wide"><label htmlFor="job-rate_notes">Rates</label><textarea rows={3} maxLength={2000} placeholder="Bill rate and pay package, as agreed with the facility." {...i("rate_notes", optional)} /></div>
          <div className="field wide"><label htmlFor="job-internal_notes">Internal notes</label><textarea rows={3} maxLength={4000} {...i("internal_notes", optional)} /></div>
        </div>
      </fieldset>

      <div className="row">
        <button type="submit" disabled={saving}>{saving ? "Saving…" : submitLabel}</button>
        <button type="button" className="link" onClick={onCancel}>Cancel</button>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
    </form>
  );
}

export function JobNew({ navigate, memberships }: { navigate: Navigate; memberships: Membership[] }) {
  const [orgId, setOrgId] = useState(memberships[0].organization_id);

  async function create(pub: JobPublic, internal: JobInternal) {
    const { data, error } = await supabase.rpc("create_job", { p_organization_id: orgId, p_job: pub, p_internal: internal });
    if (error) return pipelineError(error, "job");
    navigate(`/jobs/${data.id}`);
    return null;
  }

  return (
    <section>
      <Link to="/jobs" navigate={navigate}>← Jobs</Link>
      <h1 className="page-title">New job</h1>
      <p className="muted">Saved as a draft. Open it when it's ready to publish.</p>
      <JobForm initial={{ pub: EMPTY_PUBLIC, internal: EMPTY_INTERNAL }} submitLabel="Save draft" onSubmit={create} onCancel={() => navigate("/jobs")}>
        {memberships.length > 1 && (
          <label>
            Agency{" "}
            <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
              {memberships.map((m) => <option key={m.organization_id} value={m.organization_id}>{m.organizations?.name ?? "Agency"}</option>)}
            </select>
          </label>
        )}
      </JobForm>
    </section>
  );
}

// --- Job detail --------------------------------------------------------------

type ApplicationEvent = {
  id: number;
  application_id: string;
  event_type: string;
  from_stage: ApplicationStage | null;
  to_stage: ApplicationStage | null;
  actor_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
};

export function JobDetail({ id, navigate, staff }: { id: string; navigate: Navigate; staff: StaffDirectory }) {
  const [job, setJob] = useState<Job | null | undefined>(undefined);
  const [internal, setInternal] = useState<JobInternal | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [applications, setApplications] = useState<JobApplication[]>([]);
  const [appEvents, setAppEvents] = useState<ApplicationEvent[]>([]);
  const [terms, setTerms] = useState<JobTerms | null>(null);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [consents, setConsents] = useState<Consent[]>([]);
  const [submissions, setSubmissions] = useState<JourneySubmission[]>([]);
  const [items, setItems] = useState<JourneyItem[]>([]);
  const [editing, setEditing] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);

  async function load() {
    const [j, d, e, a, t, p, c, s, ji] = await Promise.all([
      supabase.from("jobs").select("*").eq("id", id).maybeSingle(),
      supabase.from("job_internal_details").select("*").eq("job_id", id).maybeSingle(),
      supabase.from("job_events").select("id, event_type, from_status, to_status, actor_id, details, created_at").eq("job_id", id).order("created_at"),
      supabase.from("job_applications").select("*").eq("job_id", id).order("created_at", { ascending: false }),
      supabase.from("job_partner_terms").select("*").eq("job_id", id).maybeSingle(),
      supabase.from("partners").select("*").order("name"),
      supabase.from("submission_consents").select("id, application_id, partner_id, status, includes_strike, consent_version, requested_at, expires_at, responded_at").eq("job_id", id),
      supabase.from("partner_submissions").select("id, application_id, partner_id, status, partner_candidate_reference, submitted_at, attribution_expires_on, status_reason, version, stage, stage_updated_at, stage_note, assignment_start_on, assignment_end_on").eq("job_id", id),
      supabase.from("journey_items").select("id, application_id, title, owner, status, due_on, note, source, version, job_applications!inner(job_id)").eq("job_applications.job_id", id).order("created_at"),
    ]);
    const apps = (a.data ?? []) as JobApplication[];
    const ae = apps.length
      ? await supabase
          .from("application_events")
          .select("id, application_id, event_type, from_stage, to_stage, actor_id, details, created_at")
          .in("application_id", apps.map((x) => x.id))
          .order("created_at")
      : { data: [] };
    setJob(j.data as Job | null);
    setInternal(d.data as JobInternal | null);
    setEvents((e.data ?? []) as JobEvent[]);
    setApplications(apps);
    setAppEvents((ae.data ?? []) as ApplicationEvent[]);
    setTerms(t.data as JobTerms | null);
    setPartners((p.data ?? []) as Partner[]);
    setConsents((c.data ?? []) as Consent[]);
    setSubmissions((s.data ?? []) as JourneySubmission[]);
    setItems((ji.data ?? []) as unknown as JourneyItem[]);
  }

  // thing names the record in conflict messages ("job" or "application").
  const saver = (thing: string): Save => async (call) => {
    const { error } = await call();
    if (error?.code === "PT409") {
      setConflict(pipelineError(error, thing));
      await load();
      // The notice sits above the forms; the job form's Save button is far below it.
      window.scrollTo({ top: 0, behavior: "smooth" });
      return { ok: false, error: null };
    }
    if (error) return { ok: false, error: pipelineError(error, thing) };
    setConflict(null);
    await load();
    return { ok: true, error: null };
  };
  const saveJob = saver("job");
  const saveApplication = saver("application");

  useEffect(() => {
    setJob(undefined);
    setConflict(null);
    setEditing(false);
    load();
  }, [id]);

  const back = <Link to="/jobs" navigate={navigate}>← Jobs</Link>;
  if (job === undefined) return <p className="muted">Loading…</p>;
  if (job === null || !internal) return <>{back}<p>Job not found, or you don't have access to it.</p></>;

  async function update(pub: JobPublic, int: JobInternal) {
    const { ok, error } = await saveJob(() =>
      supabase.rpc("update_job", { p_job_id: job!.id, p_expected_version: job!.version, p_job: pub, p_internal: int }),
    );
    if (ok) setEditing(false);
    return error;
  }

  const publicFields: [string, React.ReactNode][] = [
    ["Specialty", job.specialty],
    ["Employment type", EMPLOYMENT_LABELS[job.employment_type]],
    ["Location", `${job.city}, ${job.state}`],
    ["Shift", job.shift && label(job.shift)],
    ["Hours per week", job.hours_per_week],
    ["Start date", job.start_date && formatDate(job.start_date)],
    ["Duration", job.duration_weeks && `${job.duration_weeks} weeks`],
    ["Openings", job.openings],
    ["Published", job.published_at && formatDate(job.published_at)],
  ];
  const internalFields: [string, React.ReactNode][] = [
    ["Facility", internal.facility_name],
    ["Facility contact", internal.facility_contact],
    ["Source", SOURCE_LABELS[internal.source]],
    ["Requisition reference", internal.requisition_reference],
  ];

  return (
    <article>
      {back}
      <div className="detail-head">
        <h1>{job.title}</h1>
        <span className={`stage job-${job.status}`}>{label(job.status)}</span>
      </div>
      <p className="muted">
        {internal.facility_name} · {job.city}, {job.state} · created {formatDate(job.created_at)}
      </p>

      {conflict && <p role="alert" className="card conflict">{conflict}</p>}

      {editing ? (
        <JobForm
          key={`edit-${job.version}`}
          initial={{ pub: job, internal }}
          submitLabel="Save changes"
          onSubmit={update}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <div className="card actions">
            <JobStatusForm key={`status-${job.version}`} job={job} save={saveJob} />
            <div className="action">
              <p>Details</p>
              <div><button onClick={() => setEditing(true)}>Edit job</button></div>
            </div>
          </div>

          <h2>Public listing</h2>
          <div className="card">
            <FieldList fields={publicFields} />
            {job.public_description && <p className="note-body description">{job.public_description}</p>}
          </div>

          <h2>Internal only</h2>
          <div className="card internal">
            <FieldList fields={internalFields} />
            {internal.rate_notes && <><h3>Rates</h3><p className="note-body">{internal.rate_notes}</p></>}
            {internal.internal_notes && <><h3>Notes</h3><p className="note-body">{internal.internal_notes}</p></>}
          </div>
          <JobTermsCard job={job} terms={terms} partners={partners} save={saveJob} />
        </>
      )}

      <h2>Applications ({applications.length})</h2>
      {job.status === "open" ? (
        <AddCandidateForm job={job} applications={applications} save={saveApplication} />
      ) : (
        <p className="muted">Open the job to add candidates. New applications are refused while it's {label(job.status).toLowerCase()}.</p>
      )}
      {applications.length === 0 ? (
        <p className="muted">No applications yet.</p>
      ) : (
        <ul className="notes">
          {applications.map((a) => (
            <ApplicationCard
              key={`${a.id}-${a.version}`}
              application={a}
              events={appEvents.filter((e) => e.application_id === a.id)}
              staff={staff}
              navigate={navigate}
              save={saveApplication}
            >
              <SubmissionPanel
                application={a}
                terms={terms}
                partner={partners.find((x) => x.id === terms?.partner_id)}
                consents={consents.filter((x) => x.application_id === a.id)}
                submission={submissions.filter((x) => x.application_id === a.id).sort((x, y) => (x.status === "withdrawn" ? 1 : 0) - (y.status === "withdrawn" ? 1 : 0))[0]}
                save={saveApplication}
              />
              {terms?.partner_id && (
                <JourneyPanel
                  applicationId={a.id}
                  submission={submissions.find((x) => x.application_id === a.id && x.status === "submitted")}
                  items={items.filter((x) => x.application_id === a.id)}
                  save={saveApplication}
                />
              )}
            </ApplicationCard>
          ))}
        </ul>
      )}

      <h2>History</h2>
      <ol className="history">
        {events.map((e) => (
          <li key={e.id}>
            <span className="muted">{formatDate(e.created_at)}</span> {describeJobEvent(e, staff)}
          </li>
        ))}
      </ol>
    </article>
  );
}

function FieldList({ fields }: { fields: [string, React.ReactNode][] }) {
  return (
    <dl className="fields">
      {fields
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
    </dl>
  );
}

function describeJobEvent(e: JobEvent, staff: StaffDirectory): string {
  const by = e.actor_id ? ` by ${staffName(staff, e.actor_id)}` : "";
  switch (e.event_type) {
    case "created":
      return `Created as a draft${by}`;
    case "status_changed":
      return `${label(e.from_status ?? "")} → ${label(e.to_status ?? "")}${by}`;
    case "updated": {
      const fields = Array.isArray(e.details.fields) ? (e.details.fields as string[]).map((f) => label(f).toLowerCase()) : [];
      return `Edited ${fields.join(", ")}${by}`;
    }
    default:
      return `${label(e.event_type)}${by}`;
  }
}

function JobStatusForm({ job, save }: { job: Job; save: Save }) {
  const [status, setStatus] = useState<JobStatus>(job.status);
  const { saving, error, run } = useSave(save);
  // A published job can't return to draft, so don't offer it.
  const choices = JOB_STATUSES.filter((s) => s !== "draft" || !job.published_at);

  function submit(e: FormEvent) {
    e.preventDefault();
    run(() => supabase.rpc("set_job_status", { p_job_id: job.id, p_expected_version: job.version, p_status: status }));
  }

  return (
    <form className="action" onSubmit={submit}>
      <label htmlFor="job-status">Status</label>
      <div className="row">
        <select id="job-status" value={status} onChange={(e) => setStatus(e.target.value as JobStatus)}>
          {choices.map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </select>
        <button type="submit" disabled={saving || status === job.status}>{saving ? "Saving…" : "Update"}</button>
      </div>
      <p className="muted hint">
        {status === "open" ? "Open jobs are listed publicly and take applications." : "Only open jobs are listed or take applications."}
      </p>
      {error && <p role="alert" className="error">{error}</p>}
    </form>
  );
}

// --- Applications --------------------------------------------------------------

function AddCandidateForm({ job, applications, save }: { job: Job; applications: JobApplication[]; save: Save }) {
  const [inquiries, setInquiries] = useState<Pick<InquirySummary, "id" | "full_name" | "specialty" | "preferred_location">[] | null>(null);
  const [inquiryId, setInquiryId] = useState("");
  const { saving, error, run } = useSave(save);

  useEffect(() => {
    supabase
      .from("inquiries")
      .select("id, full_name, specialty, preferred_location")
      .eq("organization_id", job.organization_id)
      .eq("inquiry_type", "clinician")
      .neq("stage", "closed")
      .order("created_at", { ascending: false })
      .limit(200)
      .then(({ data }) => setInquiries(data ?? []));
  }, [job.organization_id]);

  const applied = new Set(applications.map((a) => a.inquiry_id));
  const choices = (inquiries ?? []).filter((i) => !applied.has(i.id));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await run(() => supabase.rpc("add_application_from_inquiry", { p_job_id: job.id, p_inquiry_id: inquiryId }))) setInquiryId("");
  }

  return (
    <form className="action add-candidate" onSubmit={submit}>
      <label htmlFor="candidate">Put forward a clinician from your inquiries</label>
      <div className="row">
        <select id="candidate" value={inquiryId} onChange={(e) => setInquiryId(e.target.value)} disabled={!inquiries}>
          <option value="">{inquiries ? (choices.length ? "Choose a clinician…" : "No open clinician inquiries left") : "Loading…"}</option>
          {choices.map((i) => (
            <option key={i.id} value={i.id}>{[i.full_name, i.specialty, i.preferred_location].filter(Boolean).join(" · ")}</option>
          ))}
        </select>
        <button type="submit" disabled={saving || !inquiryId}>{saving ? "Adding…" : "Add"}</button>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
    </form>
  );
}

function ApplicationCard({
  application: a,
  events,
  staff,
  navigate,
  save,
  children,
}: {
  application: JobApplication;
  events: ApplicationEvent[];
  staff: StaffDirectory;
  navigate: Navigate;
  save: Save;
  children?: React.ReactNode;
}) {
  const [stage, setStage] = useState<ApplicationStage>(a.stage);
  const [reason, setReason] = useState("");
  const { saving, error, run } = useSave(save);
  const needsReason = STAGES_WITH_REASON.includes(stage) && stage !== a.stage;

  function submit(e: FormEvent) {
    e.preventDefault();
    run(() =>
      supabase.rpc("change_application_stage", {
        p_application_id: a.id,
        p_expected_version: a.version,
        p_stage: stage,
        p_reason: needsReason ? reason : null,
      }),
    );
  }

  return (
    <li className="card application">
      <div className="application-head">
        <div>
          <strong>{a.inquiry_id ? <Link to={`/inquiries/${a.inquiry_id}`} navigate={navigate}>{a.full_name}</Link> : a.full_name}</strong>{" "}
          <span className={`stage app-${a.stage}`}>{label(a.stage)}</span>
          <p className="muted">
            <a href={`mailto:${a.email}`}>{a.email}</a>
            {a.phone && <> · <a href={`tel:${a.phone}`}>{a.phone}</a></>}
            {" · "}
            {a.source === "website" ? "Applied on the website" : a.source === "portal" ? "Applied through the portal" : "Added by a recruiter"} {formatDate(a.created_at)}
          </p>
          {a.stage_reason && <p className="muted">Reason: {a.stage_reason}</p>}
        </div>
        <form className="action" onSubmit={submit}>
          <div className="row">
            <select aria-label={`Stage for ${a.full_name}`} value={stage} onChange={(e) => setStage(e.target.value as ApplicationStage)}>
              {APPLICATION_STAGES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
            </select>
            <button type="submit" disabled={saving || stage === a.stage}>{saving ? "Saving…" : "Move"}</button>
          </div>
          {needsReason && (
            <input
              aria-label="Reason"
              placeholder="Reason (required)"
              maxLength={500}
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
          {error && <p role="alert" className="error">{error}</p>}
        </form>
      </div>
      {children}
      <details>
        <summary className="muted">History</summary>
        <ol className="history">
          {events.map((e) => (
            <li key={e.id}>
              <span className="muted">{formatDate(e.created_at)}</span> {describeApplicationEvent(e, staff)}
            </li>
          ))}
        </ol>
      </details>
    </li>
  );
}

function describeApplicationEvent(e: ApplicationEvent, staff: StaffDirectory): string {
  const by = e.actor_id ? ` by ${staffName(staff, e.actor_id)}` : "";
  switch (e.event_type) {
    case "created":
      return e.details.source === "website" ? "Applied on the website" : `Added from an inquiry${by}`;
    case "stage_changed": {
      const reason = typeof e.details.reason === "string" ? ` (${e.details.reason})` : "";
      return `${label(e.from_stage ?? "")} → ${label(e.to_stage ?? "")}${reason}${by}`;
    }
    default:
      return `${label(e.event_type)}${by}`;
  }
}
