"use client";
import { useState } from "react";

export function SandboxMethodButtons({ businessId, t }: { businessId: string; t: string }) {
  const [done, setDone] = useState<string | null>(null);
  const act = async (card: "ok" | "fail") => { const r = await fetch(`/api/billing/sandbox/method/${businessId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ t, card }) }); setDone(r.ok ? "אמצעי התשלום עודכן (בדיקה)." : "שגיאה"); };
  if (done) return <p className="mt-4" data-testid="sandbox-method-done">{done} <a className="underline" href="/settings/billing">לחיוב ושימוש</a></p>;
  return <div className="mt-4 flex flex-col gap-2"><button className="rounded-md bg-green-600 px-3 py-2 text-white" onClick={() => act("ok")} data-testid="sandbox-card-ok">כרטיס בדיקה תקין</button><button className="rounded-md bg-gray-600 px-3 py-2 text-white" onClick={() => act("fail")}>כרטיס בדיקה שנדחה</button></div>;
}
