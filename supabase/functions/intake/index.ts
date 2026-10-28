// POST /functions/v1/intake: public clinician and facility inquiries.
//
// Request body matches what the live website already sends to /api/leads.
// Responses follow that form's contract: any 2xx means saved, and errors are
// {"error": "<message safe to show the visitor>"}.

import { createClient } from "npm:@supabase/supabase-js@2.118.0";
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

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !allowedOrigins.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Idempotency-Key",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function reply(status: number, body: unknown, origin: string | null, requestId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Request-Id": requestId, ...corsHeaders(origin) },
  });
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, "0")).join("");
}

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
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (request.method !== "POST") {
    return reply(405, { error: "Method not allowed." }, origin, requestId);
  }
  if (!organizationSlug || !ipHashSecret) {
    log(requestId, "misconfigured");
    return reply(503, { error: "We could not save your inquiry. Please try again later." }, origin, requestId);
  }
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    return reply(415, { error: "Please submit the form again." }, origin, requestId);
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return reply(413, { error: "Your submission is too long." }, origin, requestId);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply(400, { error: "Please complete the form and try again." }, origin, requestId);
  }

  const parsed = parseIntake(body);
  if (parsed.kind === "honeypot") {
    // Look successful so automated submitters learn nothing.
    log(requestId, "honeypot");
    return reply(200, { ok: true }, origin, requestId);
  }
  if (parsed.kind === "invalid") {
    log(requestId, "invalid");
    return reply(400, { error: parsed.error }, origin, requestId);
  }

  const clientIp = (request.headers.get("X-Forwarded-For") ?? "").split(",")[0].trim();
  const clientHash = clientIp ? await hmacHex(ipHashSecret, clientIp) : null;

  const { data, error } = await supabase.rpc("submit_inquiry", {
    p_organization_slug: organizationSlug,
    p_inquiry: parsed.inquiry,
    p_idempotency_key: normalizeIdempotencyKey(request.headers.get("Idempotency-Key")),
    p_client_hash: clientHash,
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
