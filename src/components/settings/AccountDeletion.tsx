"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Button, Panel } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

/** Settings → Account: delete my user / delete the business and all its data (owner, 14-day grace). */
export function AccountDeletion({ isOwner }: { isOwner: boolean }) {
  const t = useT();
  const [status, setStatus] = useState<{ name: string; deletionScheduledFor: string | null } | null>(null);
  const [confirmMe, setConfirmMe] = useState(""); const [confirmBiz, setConfirmBiz] = useState(""); const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get<{ name: string; deletionScheduledFor: string | null }>("/api/account/business-deletion").then(setStatus).catch(() => undefined), []);
  useEffect(() => { void load(); }, [load]);
  const word = t("מחק", "DELETE");
  async function deleteMe() {
    setBusy(true);
    try { await api.post("/api/account/delete-me", { confirm: confirmMe }); window.location.href = "/"; }
    catch (e) { toast.error((e as Error).message); setBusy(false); }
  }
  async function biz(action: "request" | "cancel") {
    setBusy(true);
    try { await api.post("/api/account/business-deletion", action === "request" ? { action, confirmName: confirmBiz } : { action }); toast.success(action === "request" ? t("המחיקה נקבעה", "Deletion scheduled") : t("המחיקה בוטלה", "Deletion cancelled")); setConfirmBiz(""); await load(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  const date = status?.deletionScheduledFor ? new Date(status.deletionScheduledFor).toLocaleDateString(t.lang === "en" ? "en-GB" : "he-IL") : null;
  return (
    <div className="space-y-4" data-testid="account-deletion">
      <Panel title={t("מחיקת המשתמש שלי", "Delete my user")}>
        <p className="text-sm text-muted mb-3">{t("השם, האימייל והטלפון שלך יימחקו מיד והגישה תיחסם. רשומות העסק (לידים, שיחות) נשארות בעסק ללא זיהוי שלך. בעלים יחיד צריך קודם להעביר בעלות או למחוק את העסק.", "Your name, email and phone are erased immediately and access is removed. The business's records (leads, calls) stay with the business without identifying you. A sole owner must first transfer ownership or delete the business.")}</p>
        <div className="flex flex-wrap items-center gap-2 text-sm">{t(`כדי לאשר הקלד/י "${word}":`, `Type "${word}" to confirm:`)}<input value={confirmMe} onChange={(e) => setConfirmMe(e.target.value)} className="h-9 w-28 rounded-md border border-line bg-bg px-2" data-testid="delete-me-confirm" /><Button variant="danger" disabled={confirmMe !== word} loading={busy} onClick={deleteMe} data-testid="delete-me">{t("מחק את המשתמש שלי", "Delete my user")}</Button></div>
      </Panel>
      {isOwner && (
        <Panel title={t("מחיקת העסק וכל הנתונים", "Delete business and all data")}>
          {date ? (
            <div className="space-y-2 text-sm" data-testid="business-deletion-scheduled">
              <p className="text-bad font-medium">{t(`העסק וכל הנתונים יימחקו לצמיתות ב-${date}. החיבורים (WhatsApp, SMS, אימייל) כבר נותקו והאסימונים נמחקו.`, `The business and all its data will be permanently deleted on ${date}. Connections (WhatsApp, SMS, email) are already disconnected and their tokens erased.`)}</p>
              <Button variant="secondary" loading={busy} onClick={() => biz("cancel")} data-testid="business-deletion-cancel">{t("ביטול המחיקה", "Cancel deletion")}</Button>
            </div>
          ) : (
            <div className="space-y-2 text-sm">
              <p className="text-muted">{t("חיבור ה-WhatsApp (וגם SMS ואימייל) ינותק והאסימונים יימחקו מיד. כל שאר הנתונים – אנשי קשר, לידים, הודעות, שיחות, הקלטות, משתמשים – יימחקו לצמיתות אחרי 14 יום. עד אז אפשר לבטל.", "The WhatsApp connection (and SMS/email) is disconnected and its tokens erased immediately. All other data – contacts, leads, messages, calls, recordings, users – is permanently deleted after 14 days. You can cancel until then.")}</p>
              <div className="flex flex-wrap items-center gap-2">{t(`הקלד/י את שם העסק "${status?.name ?? ""}" לאישור:`, `Type the business name "${status?.name ?? ""}" to confirm:`)}<input value={confirmBiz} onChange={(e) => setConfirmBiz(e.target.value)} className="h-9 w-56 rounded-md border border-line bg-bg px-2" data-testid="business-deletion-confirm" /><Button variant="danger" disabled={!status || confirmBiz.trim() !== status.name.trim()} loading={busy} onClick={() => biz("request")} data-testid="business-deletion-request">{t("מחק את העסק", "Delete business")}</Button></div>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
