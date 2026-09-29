"use client";
import { useState } from "react";

export function SandboxPayButtons({ prid }: { prid: string }) {
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (result: "approved" | "declined") => {
    setBusy(true);
    try { const r = await fetch(`/api/payments/sandbox/${prid}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ result }) }); setDone(r.ok ? (result === "approved" ? "אושר (בדיקה)" : "נדחה (בדיקה)") : "שגיאה"); }
    finally { setBusy(false); }
  };
  if (done) return <p className="mt-4 font-medium" data-testid="sandbox-done">{done}</p>;
  return (
    <div className="mt-4 flex gap-2">
      <button className="rounded-md bg-green-600 px-3 py-2 text-white" disabled={busy} onClick={() => act("approved")} data-testid="sandbox-approve">אשר תשלום (בדיקה)</button>
      <button className="rounded-md bg-red-600 px-3 py-2 text-white" disabled={busy} onClick={() => act("declined")} data-testid="sandbox-decline">דחה (בדיקה)</button>
    </div>
  );
}
