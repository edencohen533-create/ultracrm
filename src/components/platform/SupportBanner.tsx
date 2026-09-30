"use client";
import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";

/** Always visible in support mode: which business, read-only, how long is left, and a way out. */
export function SupportBanner({ businessName, expiresAt }: { businessName: string; expiresAt: string }) {
  const [left, setLeft] = useState(() => new Date(expiresAt).getTime() - Date.now());
  const [busy, setBusy] = useState(false);
  useEffect(() => { const iv = setInterval(() => setLeft(new Date(expiresAt).getTime() - Date.now()), 15_000); return () => clearInterval(iv); }, [expiresAt]);
  async function end() { setBusy(true); try { await fetch("/api/platform/support/end", { method: "POST" }); } finally { window.location.href = "/platform"; } }
  const mins = Math.max(0, Math.ceil(left / 60_000));
  return (
    <div role="status" className="sticky top-[var(--topnav-h)] z-50 flex flex-wrap items-center gap-2 bg-[#b42318] px-3 py-2 text-sm font-medium text-white" data-testid="support-banner">
      <ShieldAlert size={18} aria-hidden />
      <span>מצב תמיכה בעסק „{businessName}“ · קריאה בלבד – אין שליחה, חיוג, חיוב או חשיפת סודות · נותרו {mins} דק׳ · הכניסה מתועדת</span>
      <button type="button" onClick={() => void end()} disabled={busy} className="ms-auto rounded bg-white/20 px-3 py-1 hover:bg-white/30" data-testid="support-end">סיום מצב תמיכה</button>
    </div>
  );
}
