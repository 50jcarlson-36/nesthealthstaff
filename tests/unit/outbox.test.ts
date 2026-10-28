import { describe, expect, it } from "vitest";
import { DevEmailAdapter, type EmailAdapter, redactEmail, ResendEmailAdapter } from "../../supabase/functions/_shared/email.ts";
import { type Completion, type OutboxRow, processOutbox } from "../../supabase/functions/_shared/outbox.ts";
import { DEFAULT_PORTAL_URLS } from "../../supabase/functions/_shared/portals.ts";
import { renderTemplate } from "../../supabase/functions/_shared/templates.ts";

function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    template: "clinician_inquiry_confirmation",
    recipient: "clinician@example.com",
    template_data: { organization_name: "Nest Health Staff" },
    attempts: 1,
    ...overrides,
  };
}

function store(rows: OutboxRow[]) {
  const completions: Completion[] = [];
  return {
    completions,
    claim: () => Promise.resolve(rows),
    complete: (c: Completion) => {
      completions.push(c);
      return Promise.resolve(c.success ? "sent" : c.retryable ? "pending" : "failed");
    },
  };
}

describe("processOutbox", () => {
  it("sends with the outbox row id as the provider idempotency key", async () => {
    const adapter = new DevEmailAdapter(() => {});
    const s = store([row()]);
    const summary = await processOutbox(s, adapter, DEFAULT_PORTAL_URLS);

    expect(summary).toEqual({ claimed: 1, sent: 1, retrying: 0, failed: 0, lost: 0 });
    expect(adapter.sent[0].idempotencyKey).toBe(row().id);
    expect(s.completions[0]).toMatchObject({ success: true, provider: "dev" });
  });

  it("reports retryable provider failures as retrying and unknown templates as failed", async () => {
    const failing: EmailAdapter = {
      provider: "test",
      send: () => Promise.resolve({ ok: false, provider: "test", error: "HTTP 503", retryable: true }),
    };
    const s = store([row(), row({ id: "22222222-2222-2222-2222-222222222222", template: "nope" })]);
    const summary = await processOutbox(s, failing, DEFAULT_PORTAL_URLS);

    expect(summary).toEqual({ claimed: 2, sent: 0, retrying: 1, failed: 1, lost: 0 });
    expect(s.completions[1]).toMatchObject({ success: false, retryable: false, error: "Unknown notification template: nope" });
  });
});

describe("ResendEmailAdapter", () => {
  const email = { idempotencyKey: "row-id-123", to: "a@example.com", subject: "s", text: "t", html: "<p>t</p>" };

  it("sends the Idempotency-Key header and classifies errors", async () => {
    const calls: RequestInit[] = [];
    const respond = (status: number, body: string) => (_: unknown, init?: RequestInit) => {
      calls.push(init!);
      return Promise.resolve(new Response(body, { status }));
    };

    const ok = await new ResendEmailAdapter("re_test", "from@example.com", respond(200, '{"id":"msg_1"}') as typeof fetch).send(email);
    expect(ok).toEqual({ ok: true, provider: "resend", messageId: "msg_1" });
    expect((calls[0].headers as Record<string, string>)["Idempotency-Key"]).toBe("row-id-123");

    const throttled = await new ResendEmailAdapter("k", "f", respond(429, "slow down") as typeof fetch).send(email);
    expect(throttled).toMatchObject({ ok: false, retryable: true });

    const rejected = await new ResendEmailAdapter("k", "f", respond(422, "bad from") as typeof fetch).send(email);
    expect(rejected).toMatchObject({ ok: false, retryable: false });
  });
});

describe("templates", () => {
  it("staff alerts link to the ward back office and contain no contact details", () => {
    const email = renderTemplate(
      "staff_new_inquiry_alert",
      { inquiry_id: "abc-123", inquiry_type: "clinician", specialty: "Telemetry" },
      DEFAULT_PORTAL_URLS,
    );
    expect(email.text).toContain("https://ward.nesthealthstaff.com/inquiries/abc-123");
    expect(email.html).not.toMatch(/@|\d{3}[-. ]\d{4}/);
  });

  it("escapes template data in HTML", () => {
    const email = renderTemplate("clinician_inquiry_confirmation", { organization_name: "<script>x</script>" }, DEFAULT_PORTAL_URLS);
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("redacts recipients in logs", () => {
    expect(redactEmail("person@example.com")).toBe("***@example.com");
  });
});
