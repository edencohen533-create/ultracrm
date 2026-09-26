"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";

/** "כל מי שמשיב הסר": the global marketing block is always on; this adds removal from lists and an optional tag. */
export function UnsubscribeCard() {
  const [cfg, setCfg] = useState<{ removeFromLists: boolean; tagName: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get<{ removeFromLists: boolean; tagName: string | null }>("/api/automations/unsubscribe-settings").then(setCfg).catch(() => undefined); }, []);
  async function save(next: { removeFromLists: boolean; tagName: string | null }) {
    setBusy(true); setCfg(next);
    try { setCfg(await api.patch("/api/automations/unsubscribe-settings", next)); toast.success("הגדרת 'הסר' נשמרה"); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  if (!cfg) return null;
  return (
    <section className="jl unsub" data-testid="unsubscribe-card">
      <header><div><h2>כשמישהו משיב &quot;הסר&quot;</h2><p>תשובת &quot;הסר&quot; / STOP ב-WhatsApp או SMS, או לחיצה על קישור ההסרה במייל.</p></div></header>
      <div className="unsub-body">
        <label className="jr-check"><input type="checkbox" checked disabled /> חסימת דיוור שיווקי בכל הערוצים (תמיד פעיל, לא ניתן לכבות)</label>
        <label className="jr-check"><input type="checkbox" checked={cfg.removeFromLists} disabled={busy} onChange={(e) => save({ ...cfg, removeFromLists: e.target.checked })} data-testid="unsub-remove-lists" /> להסיר את איש הקשר מכל רשימות התפוצה</label>
        <label className="jr-check">להוסיף תגית <input className="cmp-input unsub-tag" placeholder="למשל: הוסר מדיוור" value={cfg.tagName ?? ""} onChange={(e) => setCfg({ ...cfg, tagName: e.target.value })} onBlur={() => save(cfg)} data-testid="unsub-tag" /></label>
        <p className="jr-hint">סגמנטים דינמיים מתעדכנים לבד (מי שהוסר לא זכאי לדיוור). איש הקשר עצמו נשאר במערכת, כולל השיחות והלידים שלו.</p>
      </div>
    </section>
  );
}
