"use client";
import { useState } from "react";
import { useT } from "@/components/i18n/LangProvider";

export function UnsubscribeForm({ token, business, identifier, already }: { token: string; business: string; identifier: string; already: boolean }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">(already ? "done" : "idle");
  const [error, setError] = useState("");
  const t = useT();
  async function submit() {
    setState("busy");
    try {
      const r = await fetch("/api/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? t("שגיאה", "Error"));
      setState("done");
    } catch (e) { setError((e as Error).message); setState("error"); }
  }
  if (state === "done") return <div><p className="text-sm">{t("הכתובת", "The address")} <span dir="ltr" className="font-mono">{identifier}</span> {t("הוסרה מכל הדיוור השיווקי של", "has been removed from all marketing messages from")} <b>{business}</b> {t("(אימייל, SMS ו-WhatsApp).", "(email, SMS and WhatsApp).")}</p><p className="mt-3 text-xs text-gray-500">{t("הודעות שירות (למשל אישורי הזמנה) עשויות להמשיך להישלח. לחזרה לדיוור יש לפנות לעסק.", "Service messages (e.g. order confirmations) may still be sent. To resubscribe, contact the business.")}</p></div>;
  return (
    <div>
      <p className="text-sm text-gray-700">{t("להסיר את", "Remove")} <span dir="ltr" className="font-mono">{identifier}</span> {t("מכל הדיוור השיווקי של", "from all marketing messages from")} <b>{business}</b>?</p>
      <p className="mt-1 text-xs text-gray-500">{t("ההסרה חלה על כל הערוצים: אימייל, SMS ו-WhatsApp.", "This applies to all channels: email, SMS and WhatsApp.")}</p>
      {state === "error" && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <button onClick={submit} disabled={state === "busy"} className="mt-4 w-full rounded-lg bg-gray-900 px-4 py-2.5 text-white text-sm font-medium disabled:opacity-60">{state === "busy" ? t("מבצע…", "Working…") : t("כן, הסירו אותי", "Yes, unsubscribe me")}</button>
    </div>
  );
}
