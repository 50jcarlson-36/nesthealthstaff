// Required verification item 10: notification retries do not produce duplicate
// sends. Exercises claim_notifications / complete_notification directly.
//
// claim_notifications is global, so this file first cancels every other pending
// row in the LOCAL test database to keep claims deterministic.

import { beforeEach, describe, expect, it } from "vitest";
import { DevEmailAdapter } from "../../supabase/functions/_shared/email.ts";
import { type OutboxRow, processOutbox } from "../../supabase/functions/_shared/outbox.ts";
import { DEFAULT_PORTAL_URLS } from "../../supabase/functions/_shared/portals.ts";
import { createOrganization, inquiryPayload, service, submit } from "./setup.ts";

async function claim(limit = 20): Promise<OutboxRow[]> {
  const { data, error } = await service.rpc("claim_notifications", { p_limit: limit });
  if (error) throw error;
  return data as OutboxRow[];
}

async function complete(id: string, success: boolean, retryable = true): Promise<string | null> {
  const { data, error } = await service.rpc("complete_notification", {
    p_id: id, p_success: success, p_provider: "test",
    p_error: success ? null : "simulated failure", p_retryable: retryable,
  });
  if (error) throw error;
  return data as string | null;
}

async function row(id: string) {
  const { data } = await service.from("notification_outbox").select().eq("id", id).single();
  return data!;
}

let ids: string[];

beforeEach(async () => {
  await service.from("notification_outbox").update({ status: "cancelled" }).in("status", ["pending", "sending"]);
  const org = await createOrganization(`outbox-${Math.random().toString(36).slice(2, 6)}`);
  const { inquiry_id } = await submit(org.slug, inquiryPayload());
  const { data } = await service.from("notification_outbox").select("id").eq("inquiry_id", inquiry_id!);
  ids = data!.map((r) => r.id).sort();
});

describe("10. notification delivery", () => {
  it("concurrent workers never claim the same row", async () => {
    const [a, b] = await Promise.all([claim(1), claim(1)]);
    const claimed = [...a, ...b].map((r) => r.id).sort();
    expect(claimed).toEqual(ids);
    expect(await claim()).toEqual([]);
  });

  it("a sent row is never claimed again, and late reports cannot change it", async () => {
    for (const r of await claim()) expect(await complete(r.id, true)).toBe("sent");
    expect(await claim()).toEqual([]);

    // A worker whose lease had expired reports failure afterwards.
    expect(await complete(ids[0], false)).toBeNull();
    expect((await row(ids[0])).status).toBe("sent");
  });

  it("retryable failures back off, then retry the same row (same idempotency key)", async () => {
    const [first] = await claim(1);
    expect(await complete(first.id, false)).toBe("pending");

    const after = await row(first.id);
    expect(after.attempts).toBe(1);
    expect(new Date(after.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    expect((await claim()).map((r) => r.id)).not.toContain(first.id);

    // Once the backoff has elapsed the same row id is claimed again.
    await service.from("notification_outbox").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("id", first.id);
    const retry = await claim();
    expect(retry.map((r) => r.id)).toContain(first.id);
    expect(retry.find((r) => r.id === first.id)!.attempts).toBe(2);
  });

  it("a crashed worker's expired lease is reclaimed under the same id", async () => {
    const [stuck] = await claim(1);
    await service.from("notification_outbox").update({ locked_until: new Date(Date.now() - 1000).toISOString() }).eq("id", stuck.id);
    const reclaimed = await claim();
    expect(reclaimed.map((r) => r.id)).toContain(stuck.id);
  });

  it("stops after max_attempts and marks the row failed", async () => {
    await service.from("notification_outbox").update({ max_attempts: 2 }).in("id", ids);
    for (let attempt = 1; attempt <= 2; attempt++) {
      await service.from("notification_outbox").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).in("id", ids);
      for (const r of await claim()) await complete(r.id, false);
    }
    for (const id of ids) expect((await row(id)).status).toBe("failed");
    expect(await claim()).toEqual([]);
  });

  it("non-retryable failures fail immediately", async () => {
    const [r] = await claim(1);
    expect(await complete(r.id, false, false)).toBe("failed");
  });

  it("the worker loop sends each queued notification exactly once across repeated runs", async () => {
    const adapter = new DevEmailAdapter(() => {});
    const store = {
      claim,
      complete: (c: { id: string; success: boolean; retryable: boolean }) => complete(c.id, c.success, c.retryable),
    };
    const first = await processOutbox(store, adapter, DEFAULT_PORTAL_URLS);
    const second = await processOutbox(store, adapter, DEFAULT_PORTAL_URLS);

    expect(first).toMatchObject({ claimed: 2, sent: 2 });
    expect(second).toMatchObject({ claimed: 0, sent: 0 });
    expect(adapter.sent.map((e) => e.idempotencyKey).sort()).toEqual(ids);
  });
});
