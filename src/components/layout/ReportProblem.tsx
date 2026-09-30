"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { api, recentClientErrors } from "@/lib/client/api";
import { Button, Modal, Textarea } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

/** "דווח על תקלה" – sends what happened plus technical context (no secrets) and returns an incident code. */
export function ReportProblem() {
  const t = useT(); const pathname = usePathname();
  const [open, setOpen] = useState(false); const [msg, setMsg] = useState(""); const [busy, setBusy] = useState(false); const [code, setCode] = useState<string | null>(null);
  async function send() {
    setBusy(true);
    try {
      const r = await api.post<{ code: string }>("/api/support/tickets", { message: msg, context: { route: pathname, userAgent: navigator.userAgent, lang: document.documentElement.lang, online: navigator.onLine, errors: recentClientErrors() } });
      setCode(r.code); setMsg("");
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <>
      <button type="button" onClick={() => { setOpen(true); setCode(null); }} className="text-[11px] text-muted hover:text-text underline" data-testid="report-problem">{t("דווח על תקלה", "Report a problem")}</button>
      <Modal open={open} onClose={() => setOpen(false)} title={t("דיווח על תקלה", "Report a problem")} footer={code ? <Button onClick={() => setOpen(false)}>{t("סגור", "Close")}</Button> : <><Button variant="ghost" onClick={() => setOpen(false)}>{t("ביטול", "Cancel")}</Button><Button onClick={send} loading={busy} disabled={msg.trim().length < 3} data-testid="report-send">{t("שליחה", "Send")}</Button></>}>
        {code ? <p className="text-sm" data-testid="report-code">{t("הדיווח התקבל. מספר התקלה:", "Received. Incident code:")} <b className="ltr">{code}</b></p> : (
          <div className="space-y-2 text-sm">
            <Textarea rows={4} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder={t("מה קרה? מה ניסית לעשות?", "What happened? What were you trying to do?")} aria-label={t("תיאור התקלה", "Describe the problem")} />
            <p className="text-xs text-muted">{t("יצורפו אוטומטית: המסך, הדפדפן וקודי השגיאה האחרונים (בלי תוכן הודעות, סיסמאות או פרטי תשלום).", "Automatically attached: the screen, browser and recent error codes (no message contents, passwords or payment details).")}</p>
          </div>
        )}
      </Modal>
    </>
  );
}
