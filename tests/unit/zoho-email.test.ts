import { describe, expect, it } from "vitest";
import { emailAdapterFromEnv, ZohoEmailAdapter } from "../../supabase/functions/_shared/email.ts";
import { type Completion, processOutbox } from "../../supabase/functions/_shared/outbox.ts";
import { DEFAULT_PORTAL_URLS } from "../../supabase/functions/_shared/portals.ts";

const config = {
  clientId: "test-client",
  clientSecret: "test-secret",
  refreshToken: "test-refresh",
  accountId: "12345",
  region: "us",
  from: "recruiting@nesthealthstaff.com",
};
const email = {
  idempotencyKey: "test-outbox-id",
  to: "recruiting@nesthealthstaff.com",
  subject: "TEST inquiry",
  text: "Review in Ward",
  html: "<p>Review in Ward</p>",
};

describe("ZohoEmailAdapter", () => {
  it("refreshes authorization and records the provider message id", async () => {
    const calls: [string, RequestInit][] = [];
    const adapter = new ZohoEmailAdapter(config, (url, init) => {
      calls.push([String(url), init!]);
      return Promise.resolve(calls.length === 1
        ? Response.json({ access_token: "test-access" })
        : Response.json({ status: { code: 200 }, data: { messageId: "message-123" } }));
    });

    expect(await adapter.send(email)).toEqual({ ok: true, provider: "zoho", messageId: "message-123" });
    expect(calls[0][0]).toBe("https://accounts.zoho.com/oauth/v2/token");
    expect(calls[1][0]).toBe("https://mail.zoho.com/api/accounts/12345/messages");
    expect(JSON.parse(calls[1][1].body as string)).toMatchObject({
      fromAddress: "recruiting@nesthealthstaff.com",
      toAddress: "recruiting@nesthealthstaff.com",
    });
  });

  it("does not send when the token refresh is refused", async () => {
    let calls = 0;
    const adapter = new ZohoEmailAdapter(config, () => {
      calls++;
      return Promise.resolve(Response.json({ error: "invalid_grant" }, { status: 400 }));
    });
    expect(await adapter.send(email)).toMatchObject({ ok: false, retryable: false });
    expect(calls).toBe(1);
  });

  it("never asks for an automatic resend after an unknown send outcome", async () => {
    let calls = 0;
    const adapter = new ZohoEmailAdapter(config, () => {
      calls++;
      return calls === 1 ? Promise.resolve(Response.json({ access_token: "test-access" })) : Promise.reject(new Error("timeout"));
    });
    expect(await adapter.send(email)).toEqual({
      ok: false,
      provider: "zoho",
      error: "Zoho send outcome unknown; reconcile before resending",
      retryable: false,
    });
  });

  it("rejects an unknown region or a non-numeric account id without calling Zoho", async () => {
    let calls = 0;
    const counting = () => {
      calls++;
      return Promise.resolve(Response.json({}));
    };
    for (const bad of [{ ...config, region: "mars" }, { ...config, accountId: "abc" }]) {
      expect(await new ZohoEmailAdapter(bad, counting).send(email)).toMatchObject({ ok: false, retryable: false });
    }
    expect(calls).toBe(0);
  });

  it("is chosen by EMAIL_PROVIDER=zoho only with complete credentials", () => {
    const env = (values: Record<string, string>) => (name: string) => values[name];
    const full = { EMAIL_PROVIDER: "zoho", ZOHO_CLIENT_ID: "a", ZOHO_CLIENT_SECRET: "b", ZOHO_REFRESH_TOKEN: "c", ZOHO_ACCOUNT_ID: "1" };
    expect(emailAdapterFromEnv(env(full)).provider).toBe("zoho");
    expect(() => emailAdapterFromEnv(env({ ...full, ZOHO_ACCOUNT_ID: "" }))).toThrow(/ZOHO_ACCOUNT_ID/);
  });
});

describe("processOutbox with Zoho", () => {
  it("fails a retried row instead of risking a second send", async () => {
    let sends = 0;
    const adapter = {
      provider: "zoho",
      send: () => {
        sends++;
        return Promise.resolve({ ok: true as const, provider: "zoho", messageId: "m" });
      },
    };
    const completions: Completion[] = [];
    const store = {
      claim: () => Promise.resolve([
        { id: "row-1", template: "clinician_inquiry_confirmation", recipient: "a@example.com", template_data: {}, attempts: 2 },
      ]),
      complete: (c: Completion) => {
        completions.push(c);
        return Promise.resolve("failed");
      },
    };

    expect(await processOutbox(store, adapter, DEFAULT_PORTAL_URLS)).toMatchObject({ claimed: 1, failed: 1, sent: 0 });
    expect(sends).toBe(0);
    expect(completions[0]).toMatchObject({ success: false, retryable: false });
  });
});
