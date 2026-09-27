"use client";

import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Button, Modal } from "@/components/ui";

interface Preview { count: number; sample: Array<{ leadId: string; name: string; attempts: number; limit: number }>; leadIds: string[] }

/**
 * Changing the quota never closes existing leads by itself. The manager sees how many existing leads the SAVED quota
 * would move to "לא רלוונטי" and approves exactly those (each one re-checked on the server before it moves).
 */
export function ExhaustionPreview({ listId = null }: { listId?: string | null }) {
  const [p, setP] = useState<Preview | null>(null); const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    try { setP(await api.get<Preview>(`/api/dialer/exhaustion${listId ? `?listId=${listId}` : ""}`)); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  async function apply() {
    if (!p) return; setBusy(true);
    try { const r = await api.post<{ moved: number }>("/api/dialer/exhaustion", { listId, leadIds: p.leadIds }); toast.success(`${r.moved} לידים הועברו ל״לא רלוונטי״`); setP(null); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="text-xs text-muted flex flex-wrap items-center gap-2" data-testid="exhaustion-preview">
      <span>שינוי המכסה חל על ניסיונות מכאן והלאה. לידים קיימים שכבר עברו את המכסה לא מועברים בלי אישור.</span>
      <Button size="sm" variant="secondary" onClick={load} loading={busy} data-testid="exhaustion-preview-open">תצוגה מקדימה ללידים קיימים</Button>
      <Modal open={Boolean(p)} onClose={() => setP(null)} title="החלת המכסה על לידים קיימים" footer={<><Button variant="ghost" onClick={() => setP(null)}>ביטול</Button>{p && p.count > 0 && <Button onClick={apply} loading={busy} data-testid="exhaustion-apply">העבר {p.count} לידים ל״לא רלוונטי״</Button>}</>}>
        {p && (p.count === 0 ? <p className="text-sm" data-testid="exhaustion-none">אין לידים קיימים שעברו את המכסה השמורה (או שהמכסה כבויה).</p> : <div className="space-y-2 text-sm">
          <p data-testid="exhaustion-count">{p.count} לידים פתוחים שלא נענו מעולם, ללא פולואפ עתידי, הגיעו למכסה. הם יעברו ל״לא רלוונטי״ עם הסיבה ״מוצו ניסיונות חיוג״ ויוסרו מתורי החיוג.</p>
          <ul className="max-h-60 overflow-y-auto divide-y divide-line">{p.sample.map((l) => <li key={l.leadId} className="flex justify-between py-1"><span>{l.name}</span><span className="tabular text-muted">{l.attempts}/{l.limit}</span></li>)}</ul>
          {p.count > p.sample.length && <p className="text-xs text-muted">ועוד {p.count - p.sample.length}…</p>}
        </div>)}
      </Modal>
    </div>
  );
}
