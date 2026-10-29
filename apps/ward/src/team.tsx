// Team: admins invite staff, change roles and remove people. Invitations go
// through the staff-invite Edge Function, which creates the person's login;
// they get access only once they sign in with the invited address.

import { FunctionsHttpError } from "@supabase/supabase-js";
import { type FormEvent, useEffect, useState } from "react";
import { formatDate, label } from "./shared.tsx";
import { pipelineError, supabase } from "./supabase.ts";

type Role = "admin" | "recruiter";
const ROLES: Role[] = ["recruiter", "admin"];

type Member = {
  user_id: string;
  full_name: string | null;
  email: string;
  role: Role;
  joined_at: string;
  last_sign_in_at: string | null;
};

type Invitation = {
  id: string;
  email: string;
  full_name: string | null;
  role: Role;
  sent_count: number;
  expires_at: string;
};

type InviteInput = { email: string; full_name: string | null; role: Role };

// The function replies {"error": "<message safe to show>"} on every refusal.
async function sendInvitation(organizationId: string, input: InviteInput): Promise<{ status?: string; error?: string }> {
  const { data, error } = await supabase.functions.invoke("staff-invite", {
    body: { organization_id: organizationId, ...input },
  });
  if (!error) return { status: (data as { status: string }).status };
  if (error instanceof FunctionsHttpError) {
    const body = await error.context.json().catch(() => null) as { error?: string } | null;
    if (body?.error) return { error: body.error };
  }
  return { error: "Couldn't send the invitation. Check your connection and try again." };
}

export function TeamPage({ organizations, userId }: { organizations: { id: string; name: string }[]; userId: string }) {
  return (
    <section>
      <div className="toolbar"><h1>Team</h1></div>
      {organizations.map((org) => (
        <TeamSection key={org.id} org={org} userId={userId} showName={organizations.length > 1} />
      ))}
    </section>
  );
}

function TeamSection({ org, userId, showName }: { org: { id: string; name: string }; userId: string; showName: boolean }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    Promise.all([
      supabase.rpc("organization_members", { p_organization_id: org.id }),
      supabase
        .from("staff_invitations")
        .select("id, email, full_name, role, sent_count, expires_at")
        .eq("organization_id", org.id)
        .is("accepted_at", null)
        .is("revoked_at", null)
        .order("created_at", { ascending: false }),
    ]).then(([m, i]) => {
      if (m.error || i.error) return setLoadError("Couldn't load the team. Refresh to try again.");
      setLoadError(null);
      setMembers(m.data as Member[]);
      setInvitations(i.data as Invitation[]);
    });
  }, [org.id, reload]);

  // Runs one change, then reloads both lists whatever the outcome.
  async function act(call: () => Promise<{ error?: string | null; notice?: string }>) {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    const result = await call();
    setBusy(false);
    setActionError(result.error ?? null);
    setNotice(result.error ? null : result.notice ?? null);
    setConfirmRemove(null);
    setReload((n) => n + 1);
    return !result.error;
  }

  const rpc = async (fn: string, args: Record<string, unknown>, notice: string) => {
    const { error } = await supabase.rpc(fn, args);
    return { error: error ? pipelineError(error, "person") : null, notice };
  };

  const invite = (input: InviteInput) =>
    act(async () => {
      const result = await sendInvitation(org.id, input);
      return {
        error: result.error,
        notice: `Invitation ${result.status === "resent" ? "sent again" : "sent"} to ${input.email}.`,
      };
    });

  const name = (m: { full_name: string | null; email: string }) => m.full_name ?? m.email;
  const expired = (i: Invitation) => new Date(i.expires_at) <= new Date();

  return (
    <div className="card">
      {showName && <h2>{org.name}</h2>}
      {loadError && <p role="alert" className="error">{loadError}</p>}
      {actionError && <p role="alert" className="error">{actionError}</p>}
      {notice && <p role="status">{notice}</p>}

      <h2>Staff</h2>
      {!members && !loadError && <p className="muted">Loading…</p>}
      {members && (
        <table>
          <thead>
            <tr><th>Name</th><th>Email</th><th>Role</th><th>Last signed in</th><th><span className="muted">Remove</span></th></tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.user_id}>
                <td>{m.full_name ?? <span className="muted">No name yet</span>}{m.user_id === userId && " (you)"}</td>
                <td>{m.email}</td>
                <td>
                  <select
                    aria-label={`Role for ${name(m)}`}
                    value={m.role}
                    disabled={busy}
                    onChange={(e) => act(() => rpc("change_staff_role", {
                      p_organization_id: org.id, p_user_id: m.user_id, p_role: e.target.value,
                    }, `${name(m)} is now ${e.target.value === "admin" ? "an admin" : "a recruiter"}.`))}
                  >
                    {ROLES.map((r) => <option key={r} value={r}>{label(r)}</option>)}
                  </select>
                </td>
                <td>{m.last_sign_in_at ? formatDate(m.last_sign_in_at) : <span className="muted">Never</span>}</td>
                <td>
                  {m.user_id === userId ? null : confirmRemove === m.user_id ? (
                    <span className="row">
                      <button
                        disabled={busy}
                        onClick={() => act(() => rpc("remove_staff_member", { p_organization_id: org.id, p_user_id: m.user_id },
                          `${name(m)} no longer has access. Their inquiries are now unassigned.`))}
                      >
                        Remove access
                      </button>
                      <button className="link" onClick={() => setConfirmRemove(null)}>Cancel</button>
                    </span>
                  ) : (
                    <button className="link" disabled={busy} onClick={() => setConfirmRemove(m.user_id)}>Remove…</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Pending invitations</h2>
      {invitations && invitations.length === 0 && <p className="muted">None.</p>}
      {invitations && invitations.length > 0 && (
        <table>
          <thead>
            <tr><th>Email</th><th>Name</th><th>Role</th><th>Expires</th><th><span className="muted">Actions</span></th></tr>
          </thead>
          <tbody>
            {invitations.map((i) => (
              <tr key={i.id}>
                <td>{i.email}</td>
                <td>{i.full_name ?? <span className="muted">Not given</span>}</td>
                <td>{label(i.role)}</td>
                <td>{expired(i) ? <span className="error">Expired</span> : formatDate(i.expires_at)}</td>
                <td>
                  <span className="row">
                    <button
                      className="link"
                      disabled={busy || i.sent_count >= 5}
                      title={i.sent_count >= 5 ? "Sent five times. Revoke it and invite again." : undefined}
                      onClick={() => invite({ email: i.email, full_name: i.full_name, role: i.role })}
                    >
                      {expired(i) ? "Renew and resend" : "Resend"}
                    </button>
                    <button
                      className="link"
                      disabled={busy}
                      onClick={() => act(() => rpc("revoke_staff_invitation", { p_invitation_id: i.id }, `Invitation to ${i.email} revoked.`))}
                    >
                      Revoke
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <InviteForm busy={busy} onInvite={invite} />
    </div>
  );
}

function InviteForm({ busy, onInvite }: { busy: boolean; onInvite: (input: InviteInput) => Promise<boolean> }) {
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<Role>("recruiter");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await onInvite({ email: email.trim(), full_name: fullName.trim() || null, role });
    if (ok) {
      setEmail("");
      setFullName("");
      setRole("recruiter");
    }
  }

  return (
    <form onSubmit={submit}>
      <h2>Invite someone</h2>
      <p className="muted hint">
        They'll get an email asking them to sign in to Ward with this address. Access starts when they do, and the
        invitation expires after 14 days.
      </p>
      <div className="grid">
        <div className="field">
          <label htmlFor="invite-email">Work email</label>
          <input id="invite-email" type="email" required maxLength={254} autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="invite-name">Name (optional)</label>
          <input id="invite-name" maxLength={160} autoComplete="off" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="invite-role">Role</label>
          <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="recruiter">Recruiter: inquiries and jobs</option>
            <option value="admin">Admin: also manages the team</option>
          </select>
        </div>
      </div>
      <p><button type="submit" disabled={busy}>{busy ? "Sending…" : "Send invitation"}</button></p>
    </form>
  );
}
