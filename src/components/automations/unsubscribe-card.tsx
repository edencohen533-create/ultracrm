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
      toast.success(t("הגדרת ההסרה נשמרה", "Unsubscribe setting saved"));
    } catch (e) { toast.error((e as Error).message); }
    finally { if (lastSave.current === version) setBusy(false); }
  }
  if (!cfg) return null;
  return (
    <section className="jl unsub" data-testid="unsubscribe-card">
      <header><div><h2>{t("כשמישהו מבקש להסיר או להפסיק ליצור קשר", "When someone asks to unsubscribe or stop contact")}</h2><p>{t("גם בקשות כמו \"אל תשלחו לי הודעות יותר\", \"אל תתקשרו אליי יותר\" ו-\"תורידו אותי מהרשימה\" מזוהות אוטומטית ב-WhatsApp וב-SMS, בנוסף לקישור ההסרה במייל.", "Clear requests such as \"stop sending me messages\", \"do not call me\" and \"remove me from the list\" are recognized on WhatsApp and SMS, alongside email unsubscribe links.")}</p></div></header>
      <div className="unsub-body">
        <label className="jr-check"><input type="checkbox" checked disabled /> {t("חסימת דיוור שיווקי בכל הערוצים (תמיד פעיל, לא ניתן לכבות)", "Block marketing messages on all channels (always on, cannot be disabled)")}</label>
        <label className="jr-check"><input type="checkbox" checked={cfg.removeFromLists} disabled={busy} onChange={(e) => save({ ...cfg, removeFromLists: e.target.checked })} data-testid="unsub-remove-lists" /> {t("להסיר את איש הקשר מכל רשימות התפוצה", "Remove the contact from all distribution lists")}</label>
        <label className="jr-check">{t("להוסיף תגית", "Add tag")} <input className="cmp-input unsub-tag" placeholder={t("למשל: הוסר מדיוור", "e.g. Unsubscribed")} value={cfg.tagName ?? ""} onChange={(e) => { revision.current++; setCfg({ ...cfg, tagName: e.target.value }); }} onBlur={() => save(cfg)} data-testid="unsub-tag" /></label>
        <p className="jr-hint">{t("בקשה ברורה חוסמת גם חיוג. בקשה עמומה מושהית לבדיקת מנהל. סגמנטים דינמיים מתעדכנים לבד (מי שהוסר לא זכאי לדיוור). איש הקשר עצמו נשאר במערכת, כולל השיחות והלידים שלו.", "Clear requests also stop calls. Uncertain requests are paused for manager review. Dynamic segments update automatically (unsubscribed contacts are not eligible for marketing). The contact itself stays in the system, including its conversations and leads.")}</p>
      </div>
    </section>
  );
}
