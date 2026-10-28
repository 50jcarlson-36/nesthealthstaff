// POST /functions/v1/apply: public applications to an open job.
//
// Same contract as intake: any 2xx means saved (a repeat from the same person
// is a 200, not an error), and errors are {"error": "<message safe to show>"}.
// The job must belong to INTAKE_ORGANIZATION_SLUG and be open; the database
// function checks both again under a lock on the job.

import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { parseApplication } from "../_shared/apply.ts";
import { clientHash, corsHeaders, jsonReply, readJsonBody } from "../_shared/http.ts";
import { allowedOriginsFromEnv, portalUrlsFromEnv } from "../_shared/portals.ts";

const env = (name: string) => Deno.env.get(name);
const MAX_BODY_BYTES = 8 * 1024;

const allowedOrigins = allowedOriginsFromEnv(env, portalUrlsFromEnv(env));
const organizationSlug = env("INTAKE_ORGANIZATION_SLUG");
const ipHashSecret = env("INTAKE_IP_HASH_SECRET");
const supabase = createClient(
  env("SUPABASE_URL")!,
  env("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const reply = (status: number, body: unknown, origin: string | null, requestId: string) =>
  jsonReply(allowedOrigins, status, body, origin, requestId);

const TRY_AGAIN = "We could not save your application. Please try again.";

// Log lines carry the request id and outcome only, never submitted values.
function log(requestId: string, outcome: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ fn: "apply", requestId, outcome, ...extra }));
}

Deno.serve(async (request) => {
  const requestId = crypto.randomUUID();
  const origin = request.headers.get("Origin");

  if (origin && !allowedOrigins.has(origin)) {
    log(requestId, "origin_rejected");
    return reply(403, { error: "This form can't be submitted from here." }, null, requestId);
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(allowedOrigins, origin) });
  }
  if (request.method !== "POST") {
    return reply(405, { error: "Method not allowed." }, origin, requestId);
  }
  if (!organizationSlug || !ipHashSecret) {
    log(requestId, "misconfigured");
    return reply(503, { error: "We could not save your application. Please try again later." }, origin, requestId);
  }

  const read = await readJsonBody(request, MAX_BODY_BYTES);
  if (read.kind === "error") {
    const message = { 400: "Please complete the form and try again.", 413: "Your application is too long.", 415: "Please submit the form again." }[read.status];
    return reply(read.status, { error: message }, origin, requestId);
  }

  const parsed = parseApplication(read.body);
  if (parsed.kind === "honeypot") {
    // Look successful so automated submitters learn nothing.
    log(requestId, "honeypot");
    return reply(200, { ok: true }, origin, requestId);
  }
  if (parsed.kind === "invalid") {
    log(requestId, "invalid");
    return reply(400, { error: parsed.error }, origin, requestId);
  }

  const { job_id, ...application } = parsed.application;
  const { data, error } = await supabase.rpc("submit_job_application", {
    p_organization_slug: organizationSlug,
    p_job_id: job_id,
    p_application: application,
    p_client_hash: await clientHash(request, ipHashSecret),
  });

  if (error) {
    // PT400 means the database's checks disagreed with the parser; the
    // request is still the visitor's to fix.
    log(requestId, "error", { code: error.code });
    if (error.code === "PT400") return reply(400, { error: "Please check your details and try again." }, origin, requestId);
    return reply(500, { error: TRY_AGAIN }, origin, requestId);
  }

  const status = (data as { status: string }).status;
  log(requestId, status);
  switch (status) {
    case "created":
      return reply(201, { ok: true }, origin, requestId);
    case "duplicate":
      return reply(200, { ok: true }, origin, requestId);
    case "job_closed":
      return reply(409, { error: "This job is no longer taking applications." }, origin, requestId);
    case "job_not_found":
      return reply(404, { error: "We couldn't find that job. Please go back to the job list." }, origin, requestId);
    case "rate_limited":
      return reply(429, { error: "We've received several applications. Please try again later." }, origin, requestId);
    default:
      return reply(500, { error: TRY_AGAIN }, origin, requestId);
  }
});
