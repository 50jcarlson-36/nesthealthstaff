// POST /functions/v1/staff-invite: an agency admin invites someone to ward.
//
// Called by ward with the admin's session token. The caller is identified by
// Supabase Auth, and invite_staff checks they're an admin of the organization
// before anything is written. Only then is the invitee's login created, so
// ward's sign-in (which never creates accounts) can email them a link. Access
// itself is granted later, by accept_staff_invitations, once they sign in.
//
// Replies: 201 created, 200 resent, 400 {"error": "<message safe to show>"},
// 401 not signed in, 403 not an admin, 502 invitation saved but the login
// couldn't be created (inviting again retries it).

import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { corsHeaders, jsonReply, readJsonBody } from "../_shared/http.ts";
import { portalUrlsFromEnv } from "../_shared/portals.ts";
import { bearerToken, parseInvite } from "../_shared/staff-invite.ts";

const env = (name: string) => Deno.env.get(name);
const MAX_BODY_BYTES = 4 * 1024;
// supabase-js functions.invoke sends these alongside the JSON body.
const ALLOW_HEADERS = "Authorization, Content-Type, apikey, x-client-info";

// Only ward calls this function.
const allowedOrigins = new Set([portalUrlsFromEnv(env).adminPortal]);
const supabase = createClient(
  env("SUPABASE_URL")!,
  env("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const reply = (status: number, body: unknown, origin: string | null, requestId: string) =>
  jsonReply(allowedOrigins, status, body, origin, requestId, ALLOW_HEADERS);

const TRY_AGAIN = "Couldn't send the invitation. Try again.";

// Log lines carry the request id and outcome only, never the invitee's address.
function log(requestId: string, outcome: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ fn: "staff-invite", requestId, outcome, ...extra }));
}

Deno.serve(async (request) => {
  const requestId = crypto.randomUUID();
  const origin = request.headers.get("Origin");

  if (origin && !allowedOrigins.has(origin)) {
    log(requestId, "origin_rejected");
    return reply(403, { error: "Invitations can only be sent from Ward." }, null, requestId);
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(allowedOrigins, origin, ALLOW_HEADERS) });
  }
  if (request.method !== "POST") {
    return reply(405, { error: "Method not allowed." }, origin, requestId);
  }

  const token = bearerToken(request);
  const { data: auth } = token ? await supabase.auth.getUser(token) : { data: { user: null } };
  if (!auth.user) {
    log(requestId, "unauthenticated");
    return reply(401, { error: "Your session has ended. Sign in again." }, origin, requestId);
  }

  const read = await readJsonBody(request, MAX_BODY_BYTES);
  if (read.kind === "error") {
    const message = { 400: "Fill in the invitation form and try again.", 413: "That invitation is too long.", 415: TRY_AGAIN }[read.status];
    return reply(read.status, { error: message }, origin, requestId);
  }
  const parsed = parseInvite(read.body);
  if (parsed.kind === "invalid") {
    log(requestId, "invalid");
    return reply(400, { error: parsed.error }, origin, requestId);
  }
  const invite = parsed.invite;

  const { data, error } = await supabase.rpc("invite_staff", {
    p_actor_id: auth.user.id,
    p_organization_id: invite.organization_id,
    p_email: invite.email,
    p_full_name: invite.full_name,
    p_role: invite.role,
  });
  if (error) {
    log(requestId, "refused", { code: error.code });
    if (error.code === "PT403") return reply(403, { error: "Only agency admins can invite staff." }, origin, requestId);
    if (error.code === "PT400") return reply(400, { error: error.message }, origin, requestId);
    return reply(500, { error: TRY_AGAIN }, origin, requestId);
  }
  const result = data as { status: "created" | "resent"; invitation_id: string; expires_at: string };

  // The person may already have a login (another agency, or an earlier
  // invitation); either way ward's sign-in will now find it.
  const created = await supabase.auth.admin.createUser({ email: invite.email, email_confirm: true });
  if (created.error && created.error.code !== "email_exists" && created.error.status !== 422) {
    log(requestId, "login_failed", { status: created.error.status, code: created.error.code });
    return reply(502, {
      error: "The invitation is saved, but their login couldn't be created. Send the invitation again to retry.",
    }, origin, requestId);
  }

  log(requestId, result.status);
  return reply(result.status === "created" ? 201 : 200, {
    ok: true,
    status: result.status,
    invitation_id: result.invitation_id,
    expires_at: result.expires_at,
  }, origin, requestId);
});
