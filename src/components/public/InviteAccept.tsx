"use client";

import { useState } from "react";
import { useT } from "@/components/i18n/LangProvider";

/** Accept an invitation: set your own password (new account) or confirm with your existing account's password. */
export function InviteAccept({ token, businessName, email, mode }: { token: string; businessName: string; email: string; mode: "set_password" | "confirm_password" }) {
  const t = useT();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setting = mode === "set_password";
  const invalid = setting ? password.length < 8 || password !== confirm : password.length === 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (invalid) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/invite/${encodeURIComponent(token)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? t("שגיאה", "Error"));
      window.location.href = "/";
    } catch (err) { setError((err as Error).message); setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="space-y-3 max-w-sm">
      <p>{t(`הוזמנת להצטרף ל״${businessName}״ עם החשבון`, `You were invited to join "${businessName}" with the account`)} <b className="ltr inline-block">{email}</b>.</p>
      <p className="text-sm text-muted">{setting ? t("בחר סיסמה משלך. אף אחד אחר – גם לא בעל העסק – לא יודע אותה.", "Choose your own password. Nobody else – not even the business owner – knows it.") : t("כבר יש לך חשבון. הזן את הסיסמה שלו כדי לאשר את ההצטרפות.", "You already have an account. Enter its password to confirm.")}</p>
      <label className="block text-sm">{setting ? t("סיסמה חדשה (8 תווים לפחות)", "New password (at least 8 characters)") : t("הסיסמה של החשבון", "Account password")}
        <input type="password" autoComplete={setting ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1 w-full h-10 rounded border border-line bg-bg px-3 ltr" />
      </label>
      {setting && <label className="block text-sm">{t("אימות סיסמה", "Confirm password")}
        <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="mt-1 w-full h-10 rounded border border-line bg-bg px-3 ltr" />
      </label>}
      {error && <p className="text-sm text-bad" role="alert">{error}</p>}
      <button type="submit" disabled={invalid || busy} className="h-10 px-4 rounded bg-accent text-white disabled:opacity-50 w-full sm:w-auto">{busy ? t("מצטרף…", "Joining…") : t("הצטרפות", "Join")}</button>
    </form>
  );
}
