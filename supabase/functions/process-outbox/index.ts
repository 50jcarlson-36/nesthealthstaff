// POST /functions/v1/process-outbox: sends due notifications.
//
// Invoked on a schedule (see docs/DEPLOYMENT.md) with header
// "x-outbox-secret: <OUTBOX_PROCESSOR_SECRET>". Safe to run concurrently:
// claim_notifications hands each row to one worker at a time.

import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { emailAdapterFromEnv } from "../_shared/email.ts";
import { type OutboxRow, processOutbox } from "../_shared/outbox.ts";
import { portalUrlsFromEnv } from "../_shared/portals.ts";

const env = (name: string) => Deno.env.get(name);
const secret = env("OUTBOX_PROCESSOR_SECRET");
const portals = portalUrlsFromEnv(env);
const supabase = createClient(
  env("SUPABASE_URL")!,
  env("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all(
    [a, b].map((v) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))),
  );
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });
  if (!secret || secret.length < 32) return json(503, { error: "Processor is not configured." });
  if (!(await constantTimeEqual(request.headers.get("x-outbox-secret") ?? "", secret))) {
    return json(401, { error: "Unauthorized." });
  }

  // A misconfigured provider leaves rows pending rather than failing them.
  let adapter;
  try {
    adapter = emailAdapterFromEnv(env);
  } catch (error) {
    console.error(JSON.stringify({ fn: "process-outbox", outcome: "misconfigured", detail: String(error) }));
    return json(503, { error: "Email provider is not configured." });
  }

  const summary = await processOutbox(
    {
      async claim(limit) {
        const { data, error } = await supabase.rpc("claim_notifications", { p_limit: limit });
        if (error) throw new Error(`claim_notifications failed: ${error.message}`);
        return (data ?? []) as OutboxRow[];
      },
      async complete(result) {
        const { data, error } = await supabase.rpc("complete_notification", {
          p_id: result.id,
          p_success: result.success,
          p_provider: result.provider,
          p_provider_message_id: result.providerMessageId,
          p_error: result.error,
          p_retryable: result.retryable,
        });
        if (error) throw new Error(`complete_notification failed: ${error.message}`);
        return data as string | null;
      },
    },
    adapter,
    portals,
  );

  console.log(JSON.stringify({ fn: "process-outbox", provider: adapter.provider, ...summary }));
  return json(200, { provider: adapter.provider, ...summary });
});
