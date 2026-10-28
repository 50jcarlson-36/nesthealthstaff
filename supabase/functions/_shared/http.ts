// Request handling shared by the public form endpoints (intake, apply): origin
// checks, CORS, JSON replies, body limits and client-IP hashing. Uses only web
// platform APIs.

export function corsHeaders(allowedOrigins: Set<string>, origin: string | null): Record<string, string> {
  if (!origin || !allowedOrigins.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Idempotency-Key",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export function jsonReply(
  allowedOrigins: Set<string>,
  status: number,
  body: unknown,
  origin: string | null,
  requestId: string,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Request-Id": requestId, ...corsHeaders(allowedOrigins, origin) },
  });
}

export async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Hashed with a server secret so rate-limit rows never hold a raw IP.
export async function clientHash(request: Request, secret: string): Promise<string | null> {
  const ip = (request.headers.get("X-Forwarded-For") ?? "").split(",")[0].trim();
  return ip ? await hmacHex(secret, ip) : null;
}

export type BodyResult =
  | { kind: "ok"; body: unknown }
  | { kind: "error"; status: 400 | 413 | 415 };

// Content type, size limit and JSON parsing, in that order.
export async function readJsonBody(request: Request, maxBytes: number): Promise<BodyResult> {
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    return { kind: "error", status: 415 };
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > maxBytes) return { kind: "error", status: 413 };
  try {
    return { kind: "ok", body: JSON.parse(raw) };
  } catch {
    return { kind: "error", status: 400 };
  }
}
