// /functions/v1/partner-api: the connector a partner agency's ATS calls.
//
//   GET  /partner-api/submissions?since=&limit=&format=json|csv
//        The partner's submissions: candidate, opening, journey stage and
//        checklist. Page with "since" set to the last row's updated_at.
//   POST /partner-api/events
//        One progress update: stage, assignment dates, checklist items. Each
//        event needs a unique event_id; a retry with the same id is a no-op.
//
// Authenticated with the partner's API key (Authorization: Bearer nhs_pk_...),
// created by an agency admin in ward. Server-to-server only: browser requests
// are refused, so a key can't be used from a web page.
//
// Replies: 200, 401 missing or unknown key, 403 browser request, 404 unknown
// route or submission, 405, 413, 415, 422 rejected event, 500.

import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { apiKey, exportQuery, route, sha256Hex } from "../_shared/partner-api.ts";
import { type ExportedSubmission, submissionsToCsv } from "../_shared/partner-csv.ts";
import { readJsonBody } from "../_shared/http.ts";

const env = (name: string) => Deno.env.get(name);
const MAX_BODY_BYTES = 16 * 1024;

const supabase = createClient(
  env("SUPABASE_URL")!,
  env("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

function reply(status: number, body: unknown, requestId: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Request-Id": requestId, ...extra },
  });
}

// Log lines carry the request id and outcome only, never the key or the data.
function log(requestId: string, outcome: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ fn: "partner-api", requestId, outcome, ...extra }));
}

const UNAUTHORIZED = { error: "Send a valid partner API key as Authorization: Bearer nhs_pk_..." };
const SERVER_ERROR = { error: "Something went wrong. Try again in a minute." };

Deno.serve(async (request) => {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);

  if (request.headers.get("Origin")) {
    log(requestId, "browser_rejected");
    return reply(403, { error: "Call this API from your server, not a browser." }, requestId);
  }
  const which = route(url);
  if (!which) return reply(404, { error: "Use /submissions or /events." }, requestId);
  const expected = which === "submissions" ? "GET" : "POST";
  if (request.method !== expected) {
    return reply(405, { error: `Use ${expected} for /${which}.` }, requestId, { Allow: expected });
  }

  const key = apiKey(request);
  if (!key) {
    log(requestId, "no_key");
    return reply(401, UNAUTHORIZED, requestId, { "WWW-Authenticate": "Bearer" });
  }
  const keyHash = await sha256Hex(key);

  if (which === "submissions") {
    const query = exportQuery(url);
    if (query.kind === "invalid") return reply(400, { error: query.error }, requestId);
    const { data, error } = await supabase.rpc("partner_api_export", {
      p_key_hash: keyHash, p_since: query.since, p_limit: query.limit,
    });
    if (error) {
      log(requestId, "error", { code: error.code });
      return reply(500, SERVER_ERROR, requestId);
    }
    const result = data as { status: string; submissions: ExportedSubmission[]; has_more: boolean };
    if (result.status === "unauthorized") {
      log(requestId, "unauthorized");
      return reply(401, UNAUTHORIZED, requestId, { "WWW-Authenticate": "Bearer" });
    }
    log(requestId, "exported", { count: result.submissions.length });
    const next = result.submissions.at(-1)?.updated_at ?? null;
    if (query.format === "csv") {
      return new Response(submissionsToCsv(result.submissions), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Request-Id": requestId,
          "X-Has-More": String(result.has_more),
          ...(next && { "X-Next-Since": next }),
        },
      });
    }
    const { status: _status, ...body } = result;
    return reply(200, { ...body, next_since: next }, requestId);
  }

  const read = await readJsonBody(request, MAX_BODY_BYTES);
  if (read.kind === "error") {
    const messages = { 400: "The body isn't valid JSON.", 413: "Keep each event under 16 KB.", 415: "Send JSON." };
    return reply(read.status, { error: messages[read.status] }, requestId);
  }
  if (typeof read.body !== "object" || read.body === null || Array.isArray(read.body)) {
    return reply(422, { result: "rejected", error: "Send one event as a JSON object." }, requestId);
  }
  const { data, error } = await supabase.rpc("partner_api_event", { p_key_hash: keyHash, p_event: read.body });
  if (error) {
    log(requestId, "error", { code: error.code });
    return reply(500, SERVER_ERROR, requestId);
  }
  const { status, ...result } = data as { status: string; result: string };
  if (status === "unauthorized") {
    log(requestId, "unauthorized");
    return reply(401, UNAUTHORIZED, requestId, { "WWW-Authenticate": "Bearer" });
  }
  log(requestId, `event:${result.result}`);
  return reply(result.result === "rejected" ? 422 : 200, result, requestId);
});
