import type { Session } from "@supabase/supabase-js";
import { type FormEvent, useEffect, useState } from "react";
import {
  type Inquiry,
  type InquiryEvent,
  type InquiryNote,
  type InquiryStage,
  type InquirySummary,
  type InquiryType,
  type Membership,
  pipelineError,
  STAGES,
  type StaffMember,
  supabase,
} from "./supabase.ts";
import { JobDetail, JobList, JobNew } from "./jobs.tsx";
import { formatDate, label, Link, type Save, type StaffDirectory, staffName, useSave } from "./shared.tsx";

// --- Routing ---------------------------------------------------------------
// A handful of routes, so a small history wrapper instead of a router dependency.
// Staff alert emails link to /inquiries/<id>.

const RETURN_TO_KEY = "ward:return-to";

function usePath(): [string, (to: string) => void] {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = (to: string) => {
    window.history.pushState(null, "", to);
    setPath(to);
  };
  return [path, navigate];
}

// --- App shell ---------------------------------------------------------------

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [path, navigate] = usePath();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  // After the magic link lands on the site root, return to the page the person
  // originally opened (for example an inquiry linked from an alert email).
  useEffect(() => {
    if (!session) return;
    const returnTo = sessionStorage.getItem(RETURN_TO_KEY);
    if (returnTo) {
      sessionStorage.removeItem(RETURN_TO_KEY);
      if (returnTo !== window.location.pathname) navigate(returnTo);
    } else if (window.location.search.includes("code=")) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [session]);

  if (session === undefined) return <Centered>Loading…</Centered>;
  if (!session) return <SignIn />;
  return <StaffGate session={session} path={path} navigate={navigate} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="centered">{children}</main>;
}

// --- Sign in -----------------------------------------------------------------

function SignIn() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setState("sending");
    if (window.location.pathname !== "/") sessionStorage.setItem(RETURN_TO_KEY, window.location.pathname);
    // Ward accounts are created by an admin, never here. The response is the
    // same whether or not the address has an account, so this form can't be
    // used to discover who works at the agency.
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: false, emailRedirectTo: window.location.origin },
    });
    const benign = !error || error.code === "otp_disabled" || /signups not allowed/i.test(error.message);
    setState(benign ? "sent" : "error");
  }

  return (
    <Centered>
      <form className="card signin" onSubmit={submit}>
        <h1>Ward</h1>
        <p className="muted">Nest Health Staff back office</p>
        {state === "sent" ? (
          <p role="status">If that address has ward access, a sign-in link is on its way. It expires in one hour.</p>
        ) : (
          <>
            <label htmlFor="email">Work email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button type="submit" disabled={state === "sending"}>
              {state === "sending" ? "Sending…" : "Email me a sign-in link"}
            </button>
            {state === "error" && <p role="alert" className="error">Couldn't send the link. Try again in a minute.</p>}
          </>
        )}
      </form>
    </Centered>
  );
}

// --- Staff gate --------------------------------------------------------------

function StaffGate({ session, path, navigate }: { session: Session; path: string; navigate: (to: string) => void }) {
  const [memberships, setMemberships] = useState<Membership[] | null>(null);
  const [staff, setStaff] = useState<StaffDirectory>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("organization_memberships")
      .select("organization_id, role, organizations(name)")
      .eq("user_id", session.user.id)
      .then(async ({ data, error }) => {
        if (error) return setError("Couldn't load your access. Refresh to try again.");
        const rows = (data ?? []) as unknown as Membership[];
        // Names for assignment and history. Missing names fall back to the role.
        const directory: StaffDirectory = new Map();
        for (const m of rows) {
          const { data: members } = await supabase.rpc("organization_staff", { p_organization_id: m.organization_id });
          for (const s of (members ?? []) as StaffMember[]) {
            directory.set(s.user_id, { ...s, organization_id: m.organization_id });
          }
        }
        setStaff(directory);
        setMemberships(rows);
      });
  }, [session.user.id]);

  const signOut = () => supabase.auth.signOut();

  if (error) return <Centered><p role="alert">{error}</p></Centered>;
  if (!memberships) return <Centered>Loading…</Centered>;
  if (memberships.length === 0) {
    return (
      <Centered>
        <div className="card">
          <h1>No ward access</h1>
          <p>{session.user.email} isn't a member of any agency. Ask an admin to add you.</p>
          <button onClick={signOut}>Sign out</button>
        </div>
      </Centered>
    );
  }

  const inquiryMatch = path.match(/^\/inquiries\/([0-9a-f-]{36})$/i);
  const jobMatch = path.match(/^\/jobs\/([0-9a-f-]{36})$/i);
  const section = path.startsWith("/jobs") ? "jobs" : "inquiries";

  return (
    <>
      <header className="topbar">
        <Link to="/" navigate={navigate}>
          <strong>Ward</strong>
        </Link>
        <nav className="tabs">
          <Link to="/" navigate={navigate}><span aria-current={section === "inquiries" ? "page" : undefined}>Inquiries</span></Link>
          <Link to="/jobs" navigate={navigate}><span aria-current={section === "jobs" ? "page" : undefined}>Jobs</span></Link>
        </nav>
        <span className="muted">{memberships.map((m) => `${m.organizations?.name ?? "Agency"} · ${m.role}`).join(", ")}</span>
        <span className="spacer" />
        <span className="muted">{session.user.email}</span>
        <button className="link" onClick={signOut}>Sign out</button>
      </header>
      <main className="page">
        {inquiryMatch ? (
          <InquiryDetail id={inquiryMatch[1]} navigate={navigate} staff={staff} />
        ) : path === "/" ? (
          <InquiryList navigate={navigate} staff={staff} userId={session.user.id} />
        ) : jobMatch ? (
          <JobDetail id={jobMatch[1]} navigate={navigate} staff={staff} />
        ) : path === "/jobs/new" ? (
          <JobNew navigate={navigate} memberships={memberships} />
        ) : path === "/jobs" ? (
          <JobList navigate={navigate} />
        ) : (
          <p>Page not found. <Link to="/" navigate={navigate}>Back to inquiries</Link></p>
        )}
      </main>
    </>
  );
}

// --- Inquiry list ------------------------------------------------------------

const PAGE_SIZE = 50;

function InquiryList({ navigate, staff, userId }: { navigate: (to: string) => void; staff: StaffDirectory; userId: string }) {
  const [stage, setStage] = useState<InquiryStage | "open" | "all">("open");
  const [type, setType] = useState<InquiryType | "all">("all");
  const [owner, setOwner] = useState<"anyone" | "me" | "unassigned">("anyone");
  const [rows, setRows] = useState<InquirySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRows(null);
    let query = supabase
      .from("inquiries")
      .select("id, inquiry_type, stage, full_name, specialty, organization_name, preferred_location, assigned_recruiter_id, created_at")
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE);
    if (stage === "open") query = query.neq("stage", "closed");
    else if (stage !== "all") query = query.eq("stage", stage);
    if (type !== "all") query = query.eq("inquiry_type", type);
    if (owner === "me") query = query.eq("assigned_recruiter_id", userId);
    else if (owner === "unassigned") query = query.is("assigned_recruiter_id", null);
    query.then(({ data, error }) => {
      if (error) setError("Couldn't load inquiries.");
      else {
        setError(null);
        setRows(data as InquirySummary[]);
      }
    });
  }, [stage, type, owner, userId]);

  return (
    <section>
      <div className="toolbar">
        <h1>Inquiries</h1>
        <label>
          Stage{" "}
          <select value={stage} onChange={(e) => setStage(e.target.value as typeof stage)}>
            <option value="open">Open</option>
            <option value="all">All</option>
            {STAGES.map((s) => (
              <option key={s} value={s}>{label(s)}</option>
            ))}
          </select>
        </label>
        <label>
          Type{" "}
          <select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            <option value="all">All</option>
            <option value="clinician">Clinicians</option>
            <option value="facility">Facilities</option>
          </select>
        </label>
        <label>
          Assigned{" "}
          <select value={owner} onChange={(e) => setOwner(e.target.value as typeof owner)}>
            <option value="anyone">Anyone</option>
            <option value="me">To me</option>
            <option value="unassigned">Unassigned</option>
          </select>
        </label>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      {!rows && !error && <p className="muted">Loading…</p>}
      {rows && rows.length === 0 && <p className="muted">No inquiries match.</p>}
      {rows && rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Received</th>
              <th>Name</th>
              <th>Type</th>
              <th>Specialty / facility</th>
              <th>Location</th>
              <th>Assigned</th>
              <th>Stage</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{formatDate(r.created_at)}</td>
                <td><Link to={`/inquiries/${r.id}`} navigate={navigate}>{r.full_name}</Link></td>
                <td>{r.inquiry_type === "clinician" ? "Clinician" : "Facility"}</td>
                <td>{r.inquiry_type === "clinician" ? r.specialty : r.organization_name}</td>
                <td>{r.preferred_location}</td>
                <td className={r.assigned_recruiter_id ? undefined : "muted"}>{staffName(staff, r.assigned_recruiter_id)}</td>
                <td><span className={`stage stage-${r.stage}`}>{label(r.stage)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows?.length === PAGE_SIZE && <p className="muted">Showing the newest {PAGE_SIZE}.</p>}
    </section>
  );
}

// --- Inquiry detail ----------------------------------------------------------

function InquiryDetail({ id, navigate, staff }: { id: string; navigate: (to: string) => void; staff: StaffDirectory }) {
  const [inquiry, setInquiry] = useState<Inquiry | null | undefined>(undefined);
  const [events, setEvents] = useState<InquiryEvent[]>([]);
  const [notes, setNotes] = useState<InquiryNote[]>([]);
  // Page-level, because a reload after a conflict remounts the forms.
  const [conflict, setConflict] = useState<string | null>(null);

  async function load() {
    const [i, e, n] = await Promise.all([
      supabase.from("inquiries").select("*").eq("id", id).maybeSingle(),
      supabase
        .from("inquiry_events")
        .select("id, event_type, from_stage, to_stage, actor_id, details, created_at")
        .eq("inquiry_id", id)
        .order("created_at"),
      supabase.from("inquiry_notes").select("id, author_id, body, created_at").eq("inquiry_id", id).order("created_at", { ascending: false }),
    ]);
    setInquiry(i.data as Inquiry | null);
    setEvents((e.data ?? []) as InquiryEvent[]);
    setNotes((n.data ?? []) as InquiryNote[]);
  }

  const save: Save = async (call) => {
    const { error } = await call();
    if (error?.code === "PT409") {
      setConflict(pipelineError(error));
      await load();
      return { ok: false, error: null };
    }
    if (error) return { ok: false, error: pipelineError(error) };
    setConflict(null);
    await load();
    return { ok: true, error: null };
  };

  useEffect(() => {
    setInquiry(undefined);
    setConflict(null);
    load();
  }, [id]);

  const back = <Link to="/" navigate={navigate}>← Inquiries</Link>;
  if (inquiry === undefined) return <p className="muted">Loading…</p>;
  // RLS returns nothing for another agency's inquiry, so "not found" covers both.
  if (inquiry === null) return <>{back}<p>Inquiry not found, or you don't have access to it.</p></>;

  const clinician = inquiry.inquiry_type === "clinician";
  const fields: [string, React.ReactNode][] = [
    ["Email", <a href={`mailto:${inquiry.email}`}>{inquiry.email}</a>],
    ["Phone", inquiry.phone && <a href={`tel:${inquiry.phone}`}>{inquiry.phone}</a>],
    ...(clinician
      ? ([
          ["Specialty", inquiry.specialty],
          ["Preferred location", inquiry.preferred_location],
          ["Timeline", inquiry.timeline && (TIMELINES[inquiry.timeline] ?? label(inquiry.timeline))],
          ["Housing help", inquiry.housing_assistance_requested ? "Requested" : "No"],
        ] as [string, React.ReactNode][])
      : ([
          ["Facility", inquiry.organization_name],
          ["Location", inquiry.preferred_location],
          ["Staffing type", inquiry.staffing_type],
          ["Headcount", inquiry.headcount],
          ["Dates", [inquiry.desired_start_date, inquiry.desired_end_date].filter(Boolean).join(" → ")],
          ["Requirements", inquiry.staffing_requirements],
        ] as [string, React.ReactNode][])),
    ["Follow up on", inquiry.follow_up_on],
    ["Source", inquiry.source],
    ["Consent", `${formatDate(inquiry.consent_given_at)} (${inquiry.consent_version})`],
    ["Closed reason", inquiry.closed_reason],
  ];

  const colleagues = [...staff.values()].filter((s) => s.organization_id === inquiry.organization_id);

  return (
    <article>
      {back}
      <div className="detail-head">
        <h1>{inquiry.full_name}</h1>
        <span className={`stage stage-${inquiry.stage}`}>{label(inquiry.stage)}</span>
      </div>
      <p className="muted">
        {clinician ? "Clinician" : "Facility"} inquiry · received {formatDate(inquiry.created_at)}
      </p>

      {conflict && <p role="alert" className="card conflict">{conflict}</p>}
      <div className="card actions">
        <StageForm key={`stage-${inquiry.version}`} inquiry={inquiry} save={save} />
        <AssignForm key={`assign-${inquiry.version}`} inquiry={inquiry} colleagues={colleagues} save={save} />
      </div>

      <dl className="card fields">
        {fields
          .filter(([, v]) => v !== null && v !== undefined && v !== "")
          .map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
      </dl>

      <h2>Notes</h2>
      <NoteForm inquiryId={inquiry.id} save={save} />
      {notes.length === 0 ? (
        <p className="muted">No notes yet.</p>
      ) : (
        <ul className="notes">
          {notes.map((n) => (
            <li key={n.id} className="card">
              <p className="muted">{staffName(staff, n.author_id)} · {formatDate(n.created_at)}</p>
              <p className="note-body">{n.body}</p>
            </li>
          ))}
        </ul>
      )}

      <h2>History</h2>
      <ol className="history">
        {events.map((e) => (
          <li key={e.id}>
            <span className="muted">{formatDate(e.created_at)}</span> {describeEvent(e, staff)}
          </li>
        ))}
      </ol>
    </article>
  );
}

function describeEvent(e: InquiryEvent, staff: StaffDirectory): string {
  const by = e.actor_id ? ` by ${staffName(staff, e.actor_id)}` : "";
  switch (e.event_type) {
    case "submitted":
      return "Submitted on the website";
    case "stage_changed": {
      const reason = typeof e.details.closed_reason === "string" ? ` (${e.details.closed_reason})` : "";
      return `${label(e.from_stage ?? "")} → ${label(e.to_stage ?? "")}${reason}${by}`;
    }
    case "assigned":
      return e.details.to ? `Assigned to ${staffName(staff, e.details.to as string)}${by}` : `Unassigned${by}`;
    case "note_added":
      return `Note added${by}`;
    default:
      return `${label(e.event_type)}${by}`;
  }
}

function StageForm({ inquiry, save }: { inquiry: Inquiry; save: Save }) {
  const [stage, setStage] = useState<InquiryStage>(inquiry.stage);
  const [reason, setReason] = useState("");
  const { saving, error, run } = useSave(save);

  function submit(e: FormEvent) {
    e.preventDefault();
    run(() =>
      supabase.rpc("change_inquiry_stage", {
        p_inquiry_id: inquiry.id,
        p_expected_version: inquiry.version,
        p_stage: stage,
        p_closed_reason: stage === "closed" ? reason : null,
      }),
    );
  }

  return (
    <form className="action" onSubmit={submit}>
      <label htmlFor="stage">Stage</label>
      <div className="row">
        <select id="stage" value={stage} onChange={(e) => setStage(e.target.value as InquiryStage)}>
          {STAGES.map((s) => (
            <option key={s} value={s}>{label(s)}</option>
          ))}
        </select>
        <button type="submit" disabled={saving || stage === inquiry.stage}>{saving ? "Saving…" : "Move"}</button>
      </div>
      {stage === "closed" && stage !== inquiry.stage && (
        <input
          aria-label="Reason for closing"
          placeholder="Reason for closing (required)"
          maxLength={500}
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      )}
      {error && <p role="alert" className="error">{error}</p>}
    </form>
  );
}

function AssignForm({ inquiry, colleagues, save }: { inquiry: Inquiry; colleagues: StaffMember[]; save: Save }) {
  const { saving, error, run } = useSave(save);

  function change(value: string) {
    run(() =>
      supabase.rpc("assign_inquiry", {
        p_inquiry_id: inquiry.id,
        p_expected_version: inquiry.version,
        p_assignee_id: value || null,
      }),
    );
  }

  return (
    <div className="action">
      <label htmlFor="assignee">Assigned recruiter</label>
      <select id="assignee" disabled={saving} value={inquiry.assigned_recruiter_id ?? ""} onChange={(e) => change(e.target.value)}>
        <option value="">Unassigned</option>
        {colleagues.map((c) => (
          <option key={c.user_id} value={c.user_id}>{c.full_name ?? `Unnamed ${c.role}`}</option>
        ))}
      </select>
      {error && <p role="alert" className="error">{error}</p>}
    </div>
  );
}

function NoteForm({ inquiryId, save }: { inquiryId: string; save: Save }) {
  const [body, setBody] = useState("");
  const { saving, error, run } = useSave(save);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await run(() => supabase.rpc("add_inquiry_note", { p_inquiry_id: inquiryId, p_body: body }))) setBody("");
  }

  return (
    <form className="note-form" onSubmit={submit}>
      <textarea
        aria-label="New note"
        placeholder="Add a note. Notes can't be edited or deleted. Keep them about recruiting, not health."
        rows={3}
        maxLength={4000}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <button type="submit" disabled={saving || !body.trim()}>{saving ? "Saving…" : "Add note"}</button>
      {error && <p role="alert" className="error">{error}</p>}
    </form>
  );
}

const TIMELINES: Record<string, string> = {
  asap: "As soon as possible",
  within_1_3_months: "Within 1–3 months",
  within_3_6_months: "Within 3–6 months",
  exploring: "Just exploring",
};
