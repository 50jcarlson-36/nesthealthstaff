import type { Session } from "@supabase/supabase-js";
import { type FormEvent, useEffect, useState } from "react";
import {
  type Inquiry,
  type InquiryEvent,
  type InquiryStage,
  type InquirySummary,
  type InquiryType,
  type Membership,
  STAGES,
  supabase,
} from "./supabase.ts";

// --- Routing ---------------------------------------------------------------
// Two routes, so a small history wrapper instead of a router dependency.
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

function Link({ to, navigate, children }: { to: string; navigate: (to: string) => void; children: React.ReactNode }) {
  return (
    <a
      href={to}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("organization_memberships")
      .select("organization_id, role, organizations(name)")
      .eq("user_id", session.user.id)
      .then(({ data, error }) => {
        if (error) setError("Couldn't load your access. Refresh to try again.");
        else setMemberships((data ?? []) as unknown as Membership[]);
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

  return (
    <>
      <header className="topbar">
        <Link to="/" navigate={navigate}>
          <strong>Ward</strong>
        </Link>
        <span className="muted">{memberships.map((m) => `${m.organizations?.name ?? "Agency"} · ${m.role}`).join(", ")}</span>
        <span className="spacer" />
        <span className="muted">{session.user.email}</span>
        <button className="link" onClick={signOut}>Sign out</button>
      </header>
      <main className="page">
        {inquiryMatch ? (
          <InquiryDetail id={inquiryMatch[1]} navigate={navigate} />
        ) : path === "/" ? (
          <InquiryList navigate={navigate} />
        ) : (
          <p>Page not found. <Link to="/" navigate={navigate}>Back to inquiries</Link></p>
        )}
      </main>
    </>
  );
}

// --- Inquiry list ------------------------------------------------------------

const PAGE_SIZE = 50;

function InquiryList({ navigate }: { navigate: (to: string) => void }) {
  const [stage, setStage] = useState<InquiryStage | "open" | "all">("open");
  const [type, setType] = useState<InquiryType | "all">("all");
  const [rows, setRows] = useState<InquirySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRows(null);
    let query = supabase
      .from("inquiries")
      .select("id, inquiry_type, stage, full_name, specialty, organization_name, preferred_location, created_at")
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE);
    if (stage === "open") query = query.neq("stage", "closed");
    else if (stage !== "all") query = query.eq("stage", stage);
    if (type !== "all") query = query.eq("inquiry_type", type);
    query.then(({ data, error }) => {
      if (error) setError("Couldn't load inquiries.");
      else {
        setError(null);
        setRows(data as InquirySummary[]);
      }
    });
  }, [stage, type]);

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

function InquiryDetail({ id, navigate }: { id: string; navigate: (to: string) => void }) {
  const [inquiry, setInquiry] = useState<Inquiry | null | undefined>(undefined);
  const [events, setEvents] = useState<InquiryEvent[]>([]);

  useEffect(() => {
    setInquiry(undefined);
    supabase.from("inquiries").select("*").eq("id", id).maybeSingle().then(({ data }) => setInquiry(data as Inquiry | null));
    supabase
      .from("inquiry_events")
      .select("id, event_type, from_stage, to_stage, created_at")
      .eq("inquiry_id", id)
      .order("created_at")
      .then(({ data }) => setEvents((data ?? []) as InquiryEvent[]));
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
          ["Timeline", inquiry.timeline && label(inquiry.timeline)],
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
      <h2>History</h2>
      <ol className="history">
        {events.map((e) => (
          <li key={e.id}>
            <span className="muted">{formatDate(e.created_at)}</span> {label(e.event_type)}
            {e.to_stage && ` → ${label(e.to_stage)}`}
          </li>
        ))}
      </ol>
      <p className="muted note">Read-only for now. Stage changes, notes and assignment come with the staff pipeline (phase 2).</p>
    </article>
  );
}

// --- Formatting --------------------------------------------------------------

function label(value: string): string {
  const s = value.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: iso.length > 10 ? "short" : undefined });
}
