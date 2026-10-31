// Email delivery adapters.
//
// "dev" records nothing outside this process and never delivers mail: use it
// until a provider account, API key and verified sender domain exist.
// "resend" calls the Resend HTTP API and passes the outbox row id as the
// Idempotency-Key, so a retried send of the same row is not delivered twice.

export type OutgoingEmail = {
  idempotencyKey: string;
  to: string;
  subject: string;
  text: string;
  html: string;
};

export type SendResult =
  | { ok: true; provider: string; messageId: string | null }
  | { ok: false; provider: string; error: string; retryable: boolean };

export interface EmailAdapter {
  readonly provider: string;
  send(email: OutgoingEmail): Promise<SendResult>;
}

// Logs show only the recipient's domain.
export function redactEmail(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "[redacted]" : `***${address.slice(at)}`;
}

export class DevEmailAdapter implements EmailAdapter {
  readonly provider = "dev";
  readonly sent: OutgoingEmail[] = [];

  constructor(private readonly log: (line: string) => void = console.log) {}

  send(email: OutgoingEmail): Promise<SendResult> {
    this.sent.push(email);
    this.log(
      `[dev email, not delivered] to=${redactEmail(email.to)} subject=${JSON.stringify(email.subject)} key=${email.idempotencyKey}`,
    );
    return Promise.resolve({ ok: true, provider: this.provider, messageId: `dev-${email.idempotencyKey}` });
  }
}

export class ResendEmailAdapter implements EmailAdapter {
  readonly provider = "resend";

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
    // The sending subdomain has no inbox, so replies go to a real mailbox.
    private readonly replyTo: string | null = null,
  ) {}

  async send(email: OutgoingEmail): Promise<SendResult> {
    let response: Response;
    try {
      response = await this.fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": email.idempotencyKey,
        },
        body: JSON.stringify({
          from: this.from,
          to: [email.to],
          subject: email.subject,
          text: email.text,
          html: email.html,
          ...(this.replyTo ? { reply_to: this.replyTo } : {}),
        }),
      });
    } catch (error) {
      return { ok: false, provider: this.provider, error: `Network error: ${String(error)}`.slice(0, 500), retryable: true };
    }

    if (response.ok) {
      const body = await response.json().catch(() => ({})) as { id?: string };
      return { ok: true, provider: this.provider, messageId: body.id ?? null };
    }

    // Provider error bodies describe the request, not the recipient; keep them short.
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    return {
      ok: false,
      provider: this.provider,
      error: `HTTP ${response.status}: ${detail}`,
      retryable: response.status === 429 || response.status >= 500,
    };
  }
}

type ZohoConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accountId: string;
  region: string;
  from: string;
};

// Zoho data-centre domains by region.
const ZOHO_DOMAINS: Record<string, string> = { us: "com", eu: "eu", in: "in", au: "com.au", jp: "jp", ca: "ca" };

// Sends through a Zoho Mail mailbox. Zoho documents no idempotency key, so a
// send whose outcome is unknown is never retried automatically (see outbox.ts).
export class ZohoEmailAdapter implements EmailAdapter {
  readonly provider = "zoho";

  constructor(
    private readonly config: ZohoConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(email: OutgoingEmail): Promise<SendResult> {
    const domain = ZOHO_DOMAINS[this.config.region];
    if (!domain || !/^\d+$/.test(this.config.accountId)) {
      return { ok: false, provider: this.provider, error: "Invalid Zoho account configuration", retryable: false };
    }

    let accessToken: string;
    try {
      const tokenResponse = await this.fetchImpl(`https://accounts.zoho.${domain}/oauth/v2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          refresh_token: this.config.refreshToken,
        }),
        signal: AbortSignal.timeout(8000),
      });
      const token = await tokenResponse.json() as { access_token?: string };
      if (!tokenResponse.ok || !token.access_token) {
        return { ok: false, provider: this.provider, error: "Zoho authorization failed", retryable: false };
      }
      accessToken = token.access_token;
    } catch {
      return { ok: false, provider: this.provider, error: "Zoho authorization unavailable", retryable: true };
    }

    // From here on a failure may still have delivered the email, so nothing is retryable.
    try {
      const response = await this.fetchImpl(`https://mail.zoho.${domain}/api/accounts/${this.config.accountId}/messages`, {
        method: "POST",
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          fromAddress: this.config.from,
          toAddress: email.to,
          subject: email.subject,
          content: email.html,
          mailFormat: "html",
        }),
        signal: AbortSignal.timeout(10000),
      });
      const result = await response.json() as { status?: { code?: number }; data?: { messageId?: string } };
      if (response.ok && result.status?.code === 200 && result.data?.messageId) {
        return { ok: true, provider: this.provider, messageId: String(result.data.messageId) };
      }
      return {
        ok: false,
        provider: this.provider,
        error: `Zoho send HTTP ${response.status}; reconcile before resending`,
        retryable: false,
      };
    } catch {
      return { ok: false, provider: this.provider, error: "Zoho send outcome unknown; reconcile before resending", retryable: false };
    }
  }
}

export function emailAdapterFromEnv(env: (name: string) => string | undefined): EmailAdapter {
  const provider = env("EMAIL_PROVIDER") ?? "dev";
  if (provider === "dev") return new DevEmailAdapter();
  if (provider === "zoho") {
    const config: ZohoConfig = {
      clientId: env("ZOHO_CLIENT_ID") ?? "",
      clientSecret: env("ZOHO_CLIENT_SECRET") ?? "",
      refreshToken: env("ZOHO_REFRESH_TOKEN") ?? "",
      accountId: env("ZOHO_ACCOUNT_ID") ?? "",
      region: env("ZOHO_REGION") || "us",
      from: env("EMAIL_FROM") || "recruiting@nesthealthstaff.com",
    };
    if (!config.clientId || !config.clientSecret || !config.refreshToken || !config.accountId) {
      throw new Error("EMAIL_PROVIDER=zoho requires ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN and ZOHO_ACCOUNT_ID");
    }
    return new ZohoEmailAdapter(config);
  }
  if (provider === "resend") {
    const apiKey = env("RESEND_API_KEY");
    const from = env("EMAIL_FROM");
    if (!apiKey || !from) throw new Error("EMAIL_PROVIDER=resend requires RESEND_API_KEY and EMAIL_FROM");
    return new ResendEmailAdapter(apiKey, from, fetch, env("EMAIL_REPLY_TO") || null);
  }
  throw new Error(`Unsupported EMAIL_PROVIDER: ${provider}`);
}
