// POST /functions/v1/consent: the candidate's answer to a submission request.
//
// Called by ward's public /consent page with the token from the emailed link
// (kept in the URL fragment, so it never reaches a server log). "view" returns
// the wording and the opening; "granted" or "declined" records the answer
// once. Only the ward origin may call it.
//
// Replies: 200 {"status": ...}, 400 bad request, 404 unknown or mistyped link.

import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { parseConsentRequest } from "../_shared/consent.ts";
import { clientHash, corsHeaders, jsonReply, readJsonBody } from "../_shared/http.ts";
import { portalUrlsFromEnv } from "../_shared/portals.ts";

const env = (name: string) => Deno.env.get(name);
const MAX_BODY_BYTES = 1024;

const allowedOrigins = new Set([portalUrlsFromEnv(env).adminPortal]);
const ipHashSecret = env("INTAKE_IP_HASH_SECRET");
const supabase = createClient(
  env("SUPABASE_URL")!,
  env("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const reply = (status: number, body: unknown, origin: string | null, requestId: string) =>
  jsonReply(allowedOrigins, status, body, origin, requestId);

const NOT_FOUND = "This link isn't valid. Ask your Nest recruiter for a new one.";

// Log lines carry the request id and outcome only, never the token.
function log(requestId: string, outcome: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ fn: "consent", requestId, outcome, ...extra }));
}

Deno.serve(async (request) => {
  const requestId = crypto.randomUUID();
  const origin = request.headers.get("Origin");

  if (origin && !allowedOrigins.has(origin)) {
    log(requestId, "origin_rejected");
    return reply(403, { error: "Open the link from your email." }, null, requestId);
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(allowedOrigins, origin) });
  }
  if (request.method !== "POST") {
    return reply(405, { error: "Method not allowed." }, origin, requestId);
  }

  const read = await readJsonBody(request, MAX_BODY_BYTES);
  const parsed = read.kind === "ok" ? parseConsentRequest(read.body) : { kind: "invalid" as const };
  if (parsed.kind === "invalid") {
    log(requestId, "invalid");
    return reply(read.kind === "error" ? read.status : 404, { error: NOT_FOUND }, origin, requestId);
  }

  const { data, error } = parsed.action === "view"
    ? await supabase.rpc("view_submission_consent", { p_token: parsed.token })
    : await supabase.rpc("respond_submission_consent", {
      p_token: parsed.token,
      p_decision: parsed.action,
      p_client_hash: ipHashSecret ? await clientHash(request, ipHashSecret) : null,
    });
  if (error) {
    log(requestId, "error", { code: error.code });
    return reply(500, { error: "Something went wrong. Try again in a minute." }, origin, requestId);
  }

  const result = data as { status: string };
  log(requestId, `${parsed.action}:${result.status}`);
  if (result.status === "not_found") return reply(404, { error: NOT_FOUND }, origin, requestId);
  return reply(200, result, origin, requestId);
});
