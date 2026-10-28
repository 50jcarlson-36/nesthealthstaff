// Outbox worker loop, independent of Supabase client and runtime so it can be
// tested with fakes. The database functions claim_notifications and
// complete_notification own the state machine; this module only sends.

import type { EmailAdapter } from "./email.ts";
import type { PortalUrls } from "./portals.ts";
import { renderTemplate } from "./templates.ts";

export type OutboxRow = {
  id: string;
  template: string;
  recipient: string;
  template_data: Record<string, unknown>;
  attempts: number;
};

export type Completion = {
  id: string;
  success: boolean;
  provider: string | null;
  providerMessageId: string | null;
  error: string | null;
  retryable: boolean;
};

export type OutboxStore = {
  claim(limit: number): Promise<OutboxRow[]>;
  // Returns the row's resulting status ("sent", "pending", "failed"), or null
  // if the row was no longer claimed by this worker.
  complete(result: Completion): Promise<string | null>;
};

export type ProcessSummary = { claimed: number; sent: number; retrying: number; failed: number; lost: number };

export async function processOutbox(
  store: OutboxStore,
  adapter: EmailAdapter,
  portals: PortalUrls,
  limit = 20,
): Promise<ProcessSummary> {
  const rows = await store.claim(limit);
  const summary: ProcessSummary = { claimed: rows.length, sent: 0, retrying: 0, failed: 0, lost: 0 };

  for (const row of rows) {
    let completion: Completion;
    try {
      const email = renderTemplate(row.template, row.template_data, portals);
      const result = await adapter.send({ idempotencyKey: row.id, to: row.recipient, ...email });
      completion = result.ok
        ? { id: row.id, success: true, provider: result.provider, providerMessageId: result.messageId, error: null, retryable: false }
        : { id: row.id, success: false, provider: result.provider, providerMessageId: null, error: result.error, retryable: result.retryable };
    } catch (error) {
      // Rendering errors (unknown template) will not fix themselves.
      completion = {
        id: row.id, success: false, provider: adapter.provider, providerMessageId: null,
        error: String(error instanceof Error ? error.message : error).slice(0, 500), retryable: false,
      };
    }

    const status = await store.complete(completion);
    if (status === "sent") summary.sent++;
    else if (status === "pending") summary.retrying++;
    else if (status === "failed") summary.failed++;
    else summary.lost++;
  }

  return summary;
}
