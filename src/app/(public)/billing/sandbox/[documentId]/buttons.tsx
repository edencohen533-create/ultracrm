"use client";
import { useState } from "react";

export function SandboxBillingButtons({ documentId, t }: { documentId: string; t: string }) {
  const [done, setDone] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const act = async (outcome: "approve" | "decline") => {
    setBusy(true);
    try { const r = await fetch(`/api/billing/sandbox/${documentId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ t, outcome }) }); setDone(r.ok ? (outcome === "approve" ? "התשלום אושר (בדיקה). אפשר לחזור ל-Solina CRM – החשבון מתעדכן אחרי אימות מול הספק." : "התשלום נדחה (בדיקה).") : "שגיאה"); }
    finally { setBusy(false); }
  };
  if (done) return <p className="mt-4 font-medium" data-testid="sandbox-done">{done} <a className="underline" href="/settings/billing">לחיוב ושימוש</a></p>;
  return <div className="mt-4 flex gap-2"><button className="rounded-md bg-green-600 px-3 py-2 text-white" disabled={busy} onClick={() => act("approve")} data-testid="sandbox-approve">אשר תשלום (בדיקה)</button><button className="rounded-md bg-red-600 px-3 py-2 text-white" disabled={busy} onClick={() => act("decline")} data-testid="sandbox-decline">דחה (בדיקה)</button></div>;
}
