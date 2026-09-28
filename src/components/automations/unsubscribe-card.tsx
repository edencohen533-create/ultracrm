"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { useT } from "@/components/i18n/LangProvider";

/** "כל מי שמשיב הסר": the global marketing block is always on; this adds removal from lists and an optional tag. */
export function UnsubscribeCard() {
  const t = useT();
  const [cfg, setCfg] = useState<{ removeFromLists: boolean; tagName: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const lastSave = useRef(0);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => { api.get<{ removeFromLists: boolean; tagName: string | null }>("/api/automations/unsubscribe-settings").then(setCfg).catch(() => undefined); }, []);
  async function save(next: { removeFromLists: boolean; tagName: string | null }) {
    const version = ++revision.current;
    lastSave.current = version;
    setBusy(true); setCfg(next);
    // Preserve edits made during a slow save, and keep server writes in the same order as user actions.
    const request = pending.current.catch(() => undefined).then(() => api.patch<typeof next>("/api/automations/unsubscribe-settings", next));
    pending.current = request;
    try {
      const saved = await request;
      if (revision.current === version) setCfg(saved);
      toast.success(t("הגדרת 'הסר' נשמרה", "Unsubscribe setting saved"));
    } catch (e) { toast.error((e as Error).message); }
    finally { if (lastSave.current === version) setBusy(false); }
  }
  if (!cfg) return null;
  return (
    <section className="jl unsub" data-testid="unsubscribe-card">
      <header><div><h2>{t("כשמישהו משיב \"הסר\"", "When someone replies \"STOP\"")}</h2><p>{t("תשובת \"הסר\" / STOP ב-WhatsApp או SMS, או לחיצה על קישור ההסרה במייל.", "A STOP reply on WhatsApp or SMS, or a click on the unsubscribe link in an email.")}</p></div></header>
      <div className="unsub-body">
        <label className="jr-check"><input type="checkbox" checked disabled /> {t("חסימת דיוור שיווקי בכל הערוצים (תמיד פעיל, לא ניתן לכבות)", "Block marketing messages on all channels (always on, cannot be disabled)")}</label>
        <label className="jr-check"><input type="checkbox" checked={cfg.removeFromLists} disabled={busy} onChange={(e) => save({ ...cfg, removeFromLists: e.target.checked })} data-testid="unsub-remove-lists" /> {t("להסיר את איש הקשר מכל רשימות התפוצה", "Remove the contact from all distribution lists")}</label>
        <label className="jr-check">{t("להוסיף תגית", "Add tag")} <input className="cmp-input unsub-tag" placeholder={t("למשל: הוסר מדיוור", "e.g. Unsubscribed")} value={cfg.tagName ?? ""} onChange={(e) => { revision.current++; setCfg({ ...cfg, tagName: e.target.value }); }} onBlur={() => save(cfg)} data-testid="unsub-tag" /></label>
        <p className="jr-hint">{t("סגמנטים דינמיים מתעדכנים לבד (מי שהוסר לא זכאי לדיוור). איש הקשר עצמו נשאר במערכת, כולל השיחות והלידים שלו.", "Dynamic segments update automatically (unsubscribed contacts are not eligible for marketing). The contact itself stays in the system, including its conversations and leads.")}</p>
      </div>
    </section>
  );
}
