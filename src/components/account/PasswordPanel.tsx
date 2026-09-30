"use client";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Button, Input, Panel } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

/** Personal (account level): the sign-in password – the same in every business the person belongs to. */
export function PasswordPanel() {
  const t = useT();
  const [current, setCurrent] = useState(""); const [next, setNext] = useState(""); const [busy, setBusy] = useState(false);
  async function change() {
    if (next.length < 8) { toast.error(t("סיסמה חדשה: לפחות 8 תווים", "New password: at least 8 characters")); return; }
    setBusy(true);
    try { await api.post("/api/auth/password", { currentPassword: current, newPassword: next }); toast.success(t("הסיסמה שונתה. חיבורים אחרים של החשבון נותקו", "Password changed. Other sessions of this account were signed out")); setCurrent(""); setNext(""); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Panel title={t("החשבון שלי – שינוי סיסמה", "My account – change password")} actions={<Button size="sm" disabled={busy || !current || !next} onClick={change} data-testid="account-change-password">{t("שנה סיסמה", "Change password")}</Button>}>
      <p className="text-xs text-muted mb-2">{t("הסיסמה שייכת לחשבון הכניסה שלך בכל העסקים. שינוי מנתק כל חיבור אחר של החשבון.", "The password belongs to your sign-in account across all businesses. Changing it signs out every other session of the account.")}</p>
      <div className="grid md:grid-cols-2 gap-3">
        <Input label={t("סיסמה נוכחית", "Current password")} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <Input label={t("סיסמה חדשה (8+ תווים)", "New password (8+ characters)")} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </div>
    </Panel>
  );
}

