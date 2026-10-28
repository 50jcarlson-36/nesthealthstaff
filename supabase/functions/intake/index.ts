// POST /functions/v1/intake: public clinician and facility inquiries.
//
// Request body matches what the live website already sends to /api/leads.
// Responses follow that form's contract: any 2xx means saved, and errors are
// {"error": "<message safe to show the visitor>"}.

import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { clientHash, corsHeaders, jsonReply, readJsonBody } from "../_shared/http.ts";
import { normalizeIdempotencyKey, parseIntake } from "../_shared/intake.ts";
import { allowedOriginsFromEnv, portalUrlsFromEnv } from "../_shared/portals.ts";

const env = (name: string) => Deno.env.get(name);
const MAX_BODY_BYTES = 16 * 1024;

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

// Log lines carry the request id and outcome only, never submitted values.
function log(requestId: string, outcome: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ fn: "intake", requestId, outcome, ...extra }));
}

Deno.serve(async (request) => {
  const requestId = crypto.randomUUID();
  const origin = request.headers.get("Origin");

  // Browsers always send Origin cross-site; reject ones that are not ours.
  // Server-to-server callers (a /api/leads proxy) send none.
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
    return reply(503, { error: "We could not save your inquiry. Please try again later." }, origin, requestId);
  }
  const read = await readJsonBody(request, MAX_BODY_BYTES);
  if (read.kind === "error") {
    const message = { 400: "Please complete the form and try again.", 413: "Your submission is too long.", 415: "Please submit the form again." }[read.status];
    return reply(read.status, { error: message }, origin, requestId);
  }

  const parsed = parseIntake(read.body);
  if (parsed.kind === "honeypot") {
    // Look successful so automated submitters learn nothing.
    log(requestId, "honeypot");
    return reply(200, { ok: true }, origin, requestId);
  }
  if (parsed.kind === "invalid") {
    log(requestId, "invalid");
    return reply(400, { error: parsed.error }, origin, requestId);
  }

  const { data, error } = await supabase.rpc("submit_inquiry", {
    p_organization_slug: organizationSlug,
    p_inquiry: parsed.inquiry,
    p_idempotency_key: normalizeIdempotencyKey(request.headers.get("Idempotency-Key")),
    p_client_hash: await clientHash(request, ipHashSecret),
  });

  if (error) {
    log(requestId, "error", { code: error.code });
    return reply(500, { error: "We could not save your inquiry. Please try again." }, origin, requestId);
  }

  const status = (data as { status: string }).status;
  log(requestId, status);
  switch (status) {
    case "created":
      return reply(201, { ok: true }, origin, requestId);
    case "duplicate":
      return reply(200, { ok: true }, origin, requestId);
    case "rate_limited":
      return reply(429, { error: "We've received several submissions. Please try again later." }, origin, requestId);
    default:
      return reply(500, { error: "We could not save your inquiry. Please try again." }, origin, requestId);
  }
});
