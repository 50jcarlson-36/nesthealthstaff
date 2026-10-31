// /consent#<token>: where a candidate approves or declines one submission to a
// partner agency. No sign-in: the single-use token from the email is the
// credential. It stays in the URL fragment, which browsers never send to a
// server, and is removed from the address bar once the answer is recorded.

import { FunctionsHttpError } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { Brand } from "./brand.tsx";
import { supabase } from "./supabase.ts";

type Consent = {
  status: "pending" | "granted" | "declined" | "expired" | "revoked";
  consent_text: string;
  includes_strike: boolean;
  partner_name: string;
  job_title: string;
  city: string;
  state: string;
  expires_at: string;
  already_answered?: boolean;
};

const GENERIC_ERROR = "Something went wrong. Try again in a minute.";

async function callConsent(token: string, action: "view" | "granted" | "declined") {
  const { data, error } = await supabase.functions.invoke("consent", { body: { token, action } });
  if (!error) return { data: data as Partial<Consent> & { status: Consent["status"] } };
  if (error instanceof FunctionsHttpError) {
    const body = await error.context.json().catch(() => null) as { error?: string } | null;
    return { error: body?.error ?? GENERIC_ERROR };
  }
  return { error: GENERIC_ERROR };
}

export function ConsentPage() {
  const [token] = useState(() => window.location.hash.slice(1));
  const [consent, setConsent] = useState<Consent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!token) return setError("This link isn't complete. Open it from your email again.");
    callConsent(token, "view").then((r) => (r.error ? setError(r.error) : setConsent(r.data as Consent)));
  }, [token]);

  async function answer(decision: "granted" | "declined") {
    setSaving(true);
    setError(null);
    const r = await callConsent(token, decision);
    setSaving(false);
    if (r.error) return setError(r.error);
    setConsent((c) => c && { ...c, status: r.data!.status });
    window.history.replaceState(null, "", "/consent");
  }

  const place = consent ? `${consent.city}, ${consent.state}` : "";
  return (
    <main className="centered consent-page">
      <div className="card consent">
        <Brand />
        <p className="eyebrow">YOUR APPROVAL</p>
        {!consent && !error && <p className="muted">Loading…</p>}
        {error && <p role="alert" className="error">{error}</p>}
        {consent && (
          <>
            <h1>Submit you to {consent.partner_name}?</h1>
            <p className="muted">{consent.job_title} · {place}</p>
            {consent.includes_strike && <p className="stage strike">Strike assignment</p>}
            {consent.consent_text.split("\n\n").map((p, i) => <p key={i}>{p}</p>)}
            {consent.status === "pending" ? (
              <div className="row">
                <button disabled={saving} onClick={() => answer("granted")}>{saving ? "Saving…" : "I approve"}</button>
                <button className="link" disabled={saving} onClick={() => answer("declined")}>Don't submit me</button>
              </div>
            ) : (
              <p role="status" className="signin-notice">
                {consent.status === "granted" && <><strong>Thank you.</strong> Your approval is recorded. Your Nest recruiter will be in touch.</>}
                {consent.status === "declined" && <><strong>Understood.</strong> We won't submit you for this opening.</>}
                {consent.status === "expired" && <>This request has expired. Ask your Nest recruiter for a new link.</>}
                {consent.status === "revoked" && <>This request was replaced or cancelled. Use the newest email from Nest, or ask your recruiter.</>}
              </p>
            )}
          </>
        )}
      </div>
    </main>
  );
}
