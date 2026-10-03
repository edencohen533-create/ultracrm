"use client";
import { useState } from "react";

export function SignupForm() {
  const [f, setF] = useState({ businessName: "", fullName: "", email: "", password: "", acceptTerms: false, path: "own_crm" });
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr("");
    try { const r = await fetch("/api/public/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) }); const j = await r.json(); if (!r.ok) throw new Error(j.error ?? "שגיאה"); window.location.href = j.data.next; }
    catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  }
  const input = "w-full h-10 rounded-md border border-gray-300 px-3";
  return (
    <form onSubmit={submit} className="mt-4 space-y-3 text-sm">
      <label className="block">שם העסק<input className={input} value={f.businessName} onChange={(e) => setF({ ...f, businessName: e.target.value })} required minLength={2} /></label>
      <label className="block">השם שלך<input className={input} value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} required minLength={2} /></label>
      <label className="block">אימייל<input className={input} type="email" dir="ltr" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></label>
      <label className="block">סיסמה (10 תווים לפחות, אותיות וספרות)<input className={input} type="password" dir="ltr" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={10} autoComplete="new-password" /></label>
      <fieldset className="space-y-1"><legend className="font-medium">איך תעבדו?</legend>
        <label className="flex gap-2"><input type="radio" checked={f.path === "own_crm"} onChange={() => setF({ ...f, path: "own_crm" })} /> עם ה-CRM של Solina CRM</label>
        <label className="flex gap-2"><input type="radio" checked={f.path === "external_crm"} onChange={() => setF({ ...f, path: "external_crm" })} /> עם ה-CRM הקיים שלנו + החייגן / WhatsApp של Solina CRM</label>
      </fieldset>
      <label className="flex gap-2"><input type="checkbox" checked={f.acceptTerms} onChange={(e) => setF({ ...f, acceptTerms: e.target.checked })} required /> קראתי ואני מסכים/ה ל<a className="underline" href="/terms" target="_blank">תנאי השימוש</a> ול<a className="underline" href="/privacy" target="_blank">מדיניות הפרטיות</a></label>
      {err && <p role="alert" className="text-red-700">{err}</p>}
      <button className="w-full h-10 rounded-md bg-orange-500 text-white font-medium disabled:opacity-50" disabled={busy || !f.acceptTerms} data-testid="signup-submit">{busy ? "יוצר…" : "יצירת עסק"}</button>
      <p className="text-xs text-gray-500">כבר יש לך חשבון? <a className="underline" href="/login">התחברות</a></p>
    </form>
  );
}
