// Requests to the partner API: the API key, the route and the export query.
// Everything here is checked before the database is asked.

export const KEY_PATTERN = /^nhs_pk_[0-9a-f]{64}$/;

export function apiKey(request: Request): string | null {
  const match = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(\S+)$/i);
  return match && KEY_PATTERN.test(match[1]) ? match[1] : null;
}

// Only the hash is sent to the database, which stores nothing else.
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export type Route = "submissions" | "events" | null;

// The function is served at /functions/v1/partner-api, which reaches it as
// /partner-api; the route is the next path segment.
export function route(url: URL): Route {
  const rest = url.pathname.replace(/^.*?\/partner-api\/?/, "").replace(/\/$/, "");
  return rest === "submissions" || rest === "events" ? rest : null;
}

export type ExportQuery =
  | { kind: "ok"; since: string | null; limit: number; format: "json" | "csv" }
  | { kind: "invalid"; error: string };

export function exportQuery(url: URL): ExportQuery {
  // An unencoded "+00:00" offset arrives as " 00:00"; a space is never valid.
  const since = url.searchParams.get("since")?.replace(/ /g, "+") ?? null;
  if (since !== null && (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(since) || isNaN(Date.parse(since)))) {
    return { kind: "invalid", error: "since must be an ISO 8601 date or timestamp, like 2026-11-01T00:00:00Z." };
  }
  const limitText = url.searchParams.get("limit");
  const limit = limitText === null ? 500 : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return { kind: "invalid", error: "limit must be a whole number from 1 to 1000." };
  }
  const format = url.searchParams.get("format") ?? "json";
  if (format !== "json" && format !== "csv") return { kind: "invalid", error: "format must be json or csv." };
  return { kind: "ok", since, limit, format };
}
