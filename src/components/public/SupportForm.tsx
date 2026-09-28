"use client";

import { useState } from "react";
import { useT } from "@/components/i18n/LangProvider";

export function SupportForm() {
  const t = useT();
  const [f, setF] = useState({ name: "", email: "", businessName: "", topic: "support", message: "", website: "" });
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle"); const [err, setErr] = useState("");
  async function send(e: React.FormEvent) {
    e.preventDefault(); setState("sending");
    const r = await fetch("/api/public/support", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...f, lang: t.lang }) });
    if (r.ok) setState("sent"); else { setErr((await r.json().catch(() => ({}))).error ?? String(r.status)); setState("error"); }
  }
  if (state === "sent") return <p className="rounded-lg border border-good/40 bg-good/10 p-4" data-testid="support-sent">{t("הפנייה התקבלה. נחזור אליך בהקדם באימייל.", "Thanks – we received your message and will reply by email.")}</p>;
  const input = "block w-full mt-1 h-10 rounded-md border border-line bg-bg px-3";
  return (
    <form onSubmit={send} className="space-y-3 max-w-xl" data-testid="support-form">
      <div className="grid md:grid-cols-2 gap-3">
        <label className="text-sm">{t("שם", "Name")}<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={input} /></label>
        <label className="text-sm">{t("אימייל", "Email")}<input required type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} className={`${input} ltr`} /></label>
      </div>
      <label className="text-sm block">{t("שם העסק (לא חובה)", "Business name (optional)")}<input value={f.businessName} onChange={(e) => setF({ ...f, businessName: e.target.value })} className={input} /></label>
      <label className="text-sm block">{t("נושא", "Topic")}<select value={f.topic} onChange={(e) => setF({ ...f, topic: e.target.value })} className={input}><option value="support">{t("תמיכה טכנית", "Technical support")}</option><option value="privacy">{t("פרטיות", "Privacy")}</option><option value="deletion">{t("מחיקת נתונים", "Data deletion")}</option><option value="billing">{t("חיוב", "Billing")}</option><option value="other">{t("אחר", "Other")}</option></select></label>
      <label className="text-sm block">{t("הודעה", "Message")}<textarea required minLength={5} rows={5} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} className="block w-full mt-1 rounded-md border border-line bg-bg p-3" /></label>
      <input tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} className="hidden" aria-hidden />
      {state === "error" && <p className="text-bad text-sm">{t("השליחה נכשלה: ", "Sending failed: ")}{err}</p>}
      <button disabled={state === "sending"} className="rounded-md bg-accent text-white px-4 h-10 font-medium disabled:opacity-60" data-testid="support-submit">{state === "sending" ? t("שולח…", "Sending…") : t("שליחה", "Send")}</button>
    </form>
  );
}
