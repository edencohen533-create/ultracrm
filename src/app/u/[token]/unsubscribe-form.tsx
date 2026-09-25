"use client";
import { useState } from "react";

export function UnsubscribeForm({ token, business, identifier, already }: { token: string; business: string; identifier: string; already: boolean }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">(already ? "done" : "idle");
  const [error, setError] = useState("");
  async function submit() {
    setState("busy");
    try {
      const r = await fetch("/api/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "שגיאה");
      setState("done");
    } catch (e) { setError((e as Error).message); setState("error"); }
  }
  if (state === "done") return <div><p className="text-sm">הכתובת <span dir="ltr" className="font-mono">{identifier}</span> הוסרה מכל הדיוור השיווקי של <b>{business}</b> (אימייל, SMS ו-WhatsApp).</p><p className="mt-3 text-xs text-gray-500">הודעות שירות (למשל אישורי הזמנה) עשויות להמשיך להישלח. לחזרה לדיוור יש לפנות לעסק.</p></div>;
  return (
    <div>
      <p className="text-sm text-gray-700">להסיר את <span dir="ltr" className="font-mono">{identifier}</span> מכל הדיוור השיווקי של <b>{business}</b>?</p>
      <p className="mt-1 text-xs text-gray-500">ההסרה חלה על כל הערוצים: אימייל, SMS ו-WhatsApp.</p>
      {state === "error" && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <button onClick={submit} disabled={state === "busy"} className="mt-4 w-full rounded-lg bg-gray-900 px-4 py-2.5 text-white text-sm font-medium disabled:opacity-60">{state === "busy" ? "מבצע…" : "כן, הסירו אותי"}</button>
    </div>
  );
}
