"use client";

import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Button, Modal } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

interface Preview { count: number; sample: Array<{ leadId: string; name: string; attempts: number; limit: number }>; leadIds: string[] }

/**
 * Changing the quota never closes existing leads by itself. The manager sees how many existing leads the SAVED quota
 * would move to "לא רלוונטי" and approves exactly those (each one re-checked on the server before it moves).
 */
export function ExhaustionPreview({ listId = null }: { listId?: string | null }) {
  const t = useT();
  const [p, setP] = useState<Preview | null>(null); const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    try { setP(await api.get<Preview>(`/api/dialer/exhaustion${listId ? `?listId=${listId}` : ""}`)); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  async function apply() {
    if (!p) return; setBusy(true);
    try { const r = await api.post<{ moved: number }>("/api/dialer/exhaustion", { listId, leadIds: p.leadIds }); toast.success(t(`${r.moved} לידים הועברו ל״לא רלוונטי״`, `${r.moved} leads moved to "Not relevant"`)); setP(null); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="text-xs text-muted flex flex-wrap items-center gap-2" data-testid="exhaustion-preview">
      <span>{t("שינוי המכסה חל על ניסיונות מכאן והלאה. לידים קיימים שכבר עברו את המכסה לא מועברים בלי אישור.", "Quota changes apply to attempts from now on. Existing leads already over the quota are not moved without approval.")}</span>
      <Button size="sm" variant="secondary" onClick={load} loading={busy} data-testid="exhaustion-preview-open">{t("תצוגה מקדימה ללידים קיימים", "Preview existing leads")}</Button>
      <Modal open={Boolean(p)} onClose={() => setP(null)} title={t("החלת המכסה על לידים קיימים", "Apply quota to existing leads")} footer={<><Button variant="ghost" onClick={() => setP(null)}>{t("ביטול", "Cancel")}</Button>{p && p.count > 0 && <Button onClick={apply} loading={busy} data-testid="exhaustion-apply">{t(`העבר ${p.count} לידים ל״לא רלוונטי״`, `Move ${p.count} leads to "Not relevant"`)}</Button>}</>}>
        {p && (p.count === 0 ? <p className="text-sm" data-testid="exhaustion-none">{t("אין לידים קיימים שעברו את המכסה השמורה (או שהמכסה כבויה).", "No existing leads are over the saved quota (or the quota is off).")}</p> : <div className="space-y-2 text-sm">
          <p data-testid="exhaustion-count">{t(`${p.count} לידים פתוחים שלא נענו מעולם, ללא פולואפ עתידי, הגיעו למכסה. הם יעברו ל״לא רלוונטי״ עם הסיבה ״מוצו ניסיונות חיוג״ ויוסרו מתורי החיוג.`, `${p.count} open leads that never answered and have no upcoming follow-up have reached the quota. They will move to "Not relevant" with the reason "Dial attempts exhausted" and be removed from the dial queues.`)}</p>
          <ul className="max-h-60 overflow-y-auto divide-y divide-line">{p.sample.map((l) => <li key={l.leadId} className="flex justify-between py-1"><span>{l.name}</span><span className="tabular text-muted">{l.attempts}/{l.limit}</span></li>)}</ul>
          {p.count > p.sample.length && <p className="text-xs text-muted">{t(`ועוד ${p.count - p.sample.length}…`, `and ${p.count - p.sample.length} more…`)}</p>}
        </div>)}
      </Modal>
    </div>
  );
}
