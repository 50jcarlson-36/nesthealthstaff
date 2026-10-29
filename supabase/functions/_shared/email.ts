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

export function emailAdapterFromEnv(env: (name: string) => string | undefined): EmailAdapter {
  const provider = env("EMAIL_PROVIDER") ?? "dev";
  if (provider === "dev") return new DevEmailAdapter();
  if (provider === "resend") {
    const apiKey = env("RESEND_API_KEY");
    const from = env("EMAIL_FROM");
    if (!apiKey || !from) throw new Error("EMAIL_PROVIDER=resend requires RESEND_API_KEY and EMAIL_FROM");
    return new ResendEmailAdapter(apiKey, from, fetch, env("EMAIL_REPLY_TO") || null);
  }
  throw new Error(`Unsupported EMAIL_PROVIDER: ${provider}`);
}
