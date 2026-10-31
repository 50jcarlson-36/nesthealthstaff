// Pieces shared by the inquiry and job screens.

import { useState } from "react";
import type { StaffMember } from "./supabase.ts";

export type StaffDirectory = Map<string, StaffMember & { organization_id: string }>;

export function staffName(staff: StaffDirectory, id: string | null | undefined): string {
  if (!id) return "Unassigned";
  const s = staff.get(id);
  if (!s) return "Former staff member";
  return s.full_name ?? `Unnamed ${s.role}`;
}

export function Link({ to, navigate, children }: { to: string; navigate: (to: string) => void; children: React.ReactNode }) {
  return (
    <a
      href={to}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

// Each form sends the version it was rendered with. If someone else saved in
// between, the server refuses (PT409): the page reloads the latest state and
// shows the conflict above the forms. Forms are keyed by version, so they reset
// after any successful save.

export type RpcResult = PromiseLike<{ error: { code?: string; message: string } | null }>;
export type Save = (call: () => RpcResult) => Promise<{ ok: boolean; error: string | null }>;

export function useSave(save: Save) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(call: () => RpcResult) {
    setSaving(true);
    setError(null);
    const result = await save(call);
    setSaving(false);
    setError(result.error);
    return result.ok;
  }
  return { saving, error, run };
}

// --- Formatting --------------------------------------------------------------

export function label(value: string): string {
  const s = value.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// A bare date ("2026-12-07") is a calendar day, not UTC midnight, so it's read
// as local time; otherwise it would show as the day before west of UTC.
export function formatDate(iso: string): string {
  if (iso.length === 10) return new Date(`${iso}T00:00`).toLocaleDateString(undefined, { dateStyle: "medium" });
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
