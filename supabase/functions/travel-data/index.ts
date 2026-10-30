// POST /functions/v1/travel-data: the GSA per diem rate for an opening.
//
// Called by ward with the staff member's session, body {"job_id": "..."}. The
// caller must belong to the job's agency. The rate comes from per_diem_rates
// when it was fetched in the last 30 days; otherwise from the GSA Per Diem API
// (api.gsa.gov, key in GSA_API_KEY), and is then cached. The ZIP code is used
// when the job has one, else the city and state.
//
// Replies: 200 {"rate": {...}, "source": "cache" | "gsa"}, 400 bad request,
// 401 not signed in, 404 job not found, 422 no rate for the location,
// 502 GSA unavailable, 503 GSA_API_KEY not set.

import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { corsHeaders, jsonReply, readJsonBody } from "../_shared/http.ts";
import { portalUrlsFromEnv } from "../_shared/portals.ts";
import { bearerToken } from "../_shared/staff-invite.ts";
import { fiscalYear, parseGsaRates, perDiemLookup, type PerDiemRate } from "../_shared/travel.ts";

const env = (name: string) => Deno.env.get(name);
const MAX_BODY_BYTES = 1024;
const ALLOW_HEADERS = "Authorization, Content-Type, apikey, x-client-info";
const GSA_BASE = "https://api.gsa.gov/travel/perdiem/v2";
const CACHE_DAYS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const allowedOrigins = new Set([portalUrlsFromEnv(env).adminPortal]);
const gsaKey = env("GSA_API_KEY");
const supabase = createClient(
  env("SUPABASE_URL")!,
  env("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const reply = (status: number, body: unknown, origin: string | null, requestId: string) =>
  jsonReply(allowedOrigins, status, body, origin, requestId, ALLOW_HEADERS);

function log(requestId: string, outcome: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ fn: "travel-data", requestId, outcome, ...extra }));
}

type JobRow = {
  id: string;
  organization_id: string;
  city: string;
  state: string;
  start_date: string | null;
  job_internal_details: { facility_zip: string | null } | null;
};

Deno.serve(async (request) => {
  const requestId = crypto.randomUUID();
  const origin = request.headers.get("Origin");

  if (origin && !allowedOrigins.has(origin)) {
    log(requestId, "origin_rejected");
    return reply(403, { error: "Use Ward to look up per diem rates." }, null, requestId);
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(allowedOrigins, origin, ALLOW_HEADERS) });
  }
  if (request.method !== "POST") return reply(405, { error: "Method not allowed." }, origin, requestId);

  const token = bearerToken(request);
  const { data: auth } = token ? await supabase.auth.getUser(token) : { data: { user: null } };
  if (!auth.user) {
    log(requestId, "unauthenticated");
    return reply(401, { error: "Your session has ended. Sign in again." }, origin, requestId);
  }

  const read = await readJsonBody(request, MAX_BODY_BYTES);
  const jobId = read.kind === "ok" ? (read.body as { job_id?: unknown })?.job_id : null;
  if (typeof jobId !== "string" || !UUID.test(jobId)) {
    return reply(400, { error: "Choose a job." }, origin, requestId);
  }

  // The job, only if the caller belongs to its agency.
  const { data: job } = await supabase.from("jobs")
    .select("id, organization_id, city, state, start_date, job_internal_details(facility_zip)")
    .eq("id", jobId).maybeSingle<JobRow>();
  const { count } = job
    ? await supabase.from("organization_memberships").select("user_id", { count: "exact", head: true })
      .eq("organization_id", job.organization_id).eq("user_id", auth.user.id)
    : { count: 0 };
  if (!job || !count) {
    log(requestId, "not_found");
    return reply(404, { error: "This job no longer exists, or you've lost access to it." }, origin, requestId);
  }

  const year = fiscalYear(job.start_date ?? new Date().toISOString().slice(0, 10));
  const lookup = perDiemLookup({ zip: job.job_internal_details?.facility_zip ?? null, city: job.city, state: job.state }, year);
  if (!lookup) return reply(422, { error: "Add the facility's ZIP code to look up the per diem." }, origin, requestId);

  const { data: cached } = await supabase.from("per_diem_rates").select("*")
    .eq("fiscal_year", year).eq("lookup_key", lookup.key)
    .gte("fetched_at", new Date(Date.now() - CACHE_DAYS * 86400000).toISOString()).maybeSingle();
  if (cached) {
    log(requestId, "cache");
    return reply(200, { rate: cached, source: "cache" }, origin, requestId);
  }

  if (!gsaKey) {
    log(requestId, "not_configured");
    return reply(503, { error: "Per diem lookup isn't set up yet: the GSA API key is missing." }, origin, requestId);
  }
  let rate: PerDiemRate | null;
  try {
    const response = await fetch(`${GSA_BASE}/${lookup.path}`, {
      headers: { "x-api-key": gsaKey, Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      log(requestId, "gsa_error", { status: response.status });
      return reply(502, { error: "The GSA per diem service didn't answer. Try again later." }, origin, requestId);
    }
    rate = parseGsaRates(await response.json(), lookup, job.city, year);
  } catch {
    log(requestId, "gsa_unreachable");
    return reply(502, { error: "The GSA per diem service didn't answer. Try again later." }, origin, requestId);
  }
  if (!rate) {
    log(requestId, "no_rate");
    return reply(422, { error: "GSA has no rate for this location. Check the city, state or ZIP code." }, origin, requestId);
  }

  const { data: saved, error } = await supabase.from("per_diem_rates")
    .upsert({ ...rate, fetched_at: new Date().toISOString() }, { onConflict: "fiscal_year,lookup_key" })
    .select("*").single();
  if (error) log(requestId, "cache_write_failed", { code: error.code });
  log(requestId, "gsa");
  return reply(200, { rate: saved ?? rate, source: "gsa" }, origin, requestId);
});
