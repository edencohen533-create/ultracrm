"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { templateParameterKeys } from "@/lib/campaigns";
import { useLeadStatuses } from "@/lib/client/use-lead-statuses";

/** Quick rule: "כשסטטוס ליד משתנה ל-X → שלח הודעת WhatsApp" (saved as a customer journey). */
export function StatusWhatsAppCard({ templates }: { templates: Array<{ id: string; name: string; body: string }> }) {
  const router = useRouter();
  const statuses = useLeadStatuses();
  const [status, setStatus] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [wait, setWait] = useState(0);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const tpl = templates.find((t) => t.id === templateId);
  const keys = useMemo(() => (tpl ? templateParameterKeys(tpl.body) : []), [tpl]);
  const ready = status && templateId && keys.every((k) => vars[k]?.trim());
  async function save() {
    setBusy(true);
    try {
      const label = statuses.label(status);
      await api.post("/api/sequences", { name: `סטטוס "${label}" ← WhatsApp: ${tpl!.name}`, isActive: true, trigger: "LEAD_STATUS_CHANGED", triggerConfig: { leadStatus: status }, stopOn: [], steps: [{ action: "send", channel: "whatsapp", templateId, waitMinutes: wait, variables: vars, condition: { requireNoReply: false } }] });
      toast.success("האוטומציה נוצרה והופעלה"); setStatus(""); setTemplateId(""); setVars({}); setWait(0); router.refresh();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <section className="jl unsub" data-testid="status-whatsapp-card">
      <header><div><h2>כשסטטוס ליד משתנה ← שליחת WhatsApp</h2><p>נשלח ללקוח כשהליד שלו עובר לסטטוס שבחרת. ההודעה נשלחת רק אם הלקוח לא הסיר את עצמו מדיוור.</p></div></header>
      <div className="unsub-body sw-grid">
        <label>כשהסטטוס משתנה ל<select className="cmp-input" value={status} onChange={(e) => setStatus(e.target.value)} data-testid="sw-status"><option value="">בחר סטטוס</option>{statuses.items.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
        <label>לשלוח את התבנית<select className="cmp-input" value={templateId} onChange={(e) => { setTemplateId(e.target.value); setVars({}); }} data-testid="sw-template"><option value="">בחר תבנית WhatsApp מאושרת</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <label>אחרי<select className="cmp-input" value={wait} onChange={(e) => setWait(Number(e.target.value))}><option value={0}>מיד</option><option value={5}>5 דקות</option><option value={30}>חצי שעה</option><option value={60}>שעה</option><option value={1440}>יום</option></select></label>
        {keys.map((k) => <label key={k}>משתנה {`{{${k}}}`}<input className="cmp-input" value={vars[k] ?? ""} onChange={(e) => setVars({ ...vars, [k]: e.target.value })} placeholder="טקסט קבוע, או {name} לשם הלקוח" data-testid={`sw-var-${k}`} /></label>)}
        {tpl && <p className="sw-preview">{tpl.body}</p>}
        {!templates.length && <p className="jr-hint">אין תבניות WhatsApp מאושרות. אפשר ליצור ולסנכרן ב&quot;תבניות WhatsApp&quot;.</p>}
        <div><button className="cmp-btn primary" disabled={!ready || busy} onClick={save} data-testid="sw-save">{busy ? "שומר…" : "יצירת אוטומציה"}</button></div>
      </div>
    </section>
  );
}
