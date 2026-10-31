// Requests from the public consent page: a link token and what to do with it.
// The token is 64 hex characters; anything else is refused before the
// database is asked.

export type ConsentRequest =
  | { kind: "ok"; token: string; action: "view" | "granted" | "declined" }
  | { kind: "invalid" };

export function parseConsentRequest(body: unknown): ConsentRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { kind: "invalid" };
  const input = body as Record<string, unknown>;
  const token = typeof input.token === "string" ? input.token.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(token)) return { kind: "invalid" };
  const action = input.action;
  if (action !== "view" && action !== "granted" && action !== "declined") return { kind: "invalid" };
  return { kind: "ok", token, action };
}
