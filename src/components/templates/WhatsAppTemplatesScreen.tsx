"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Search } from "lucide-react";
import { toast } from "sonner";
import { Badge, Button } from "@/components/ui";
import { TEMPLATE_LANGUAGES } from "@/lib/validation/template";
import { TemplateBuilder } from "./TemplateBuilder";
import { WhatsAppPreview, type PreviewButton } from "./WhatsAppPreview";

export interface TemplateRow { id: string; name: string; displayName?: string | null; language: string; category: string; status: string; body: string; variables: string[]; headerFormat: string | null; buttons: PreviewButton[] | null; components: Array<{ type?: string; text?: string; format?: string }> | null; syncError: string | null; updatedAt: string }
const CATEGORY: Record<string, string> = { MARKETING: "שיווק", UTILITY: "שירות", AUTHENTICATION: "אימות" };
const STATUS: Record<string, [string, "good" | "warn" | "bad" | "neutral"]> = { APPROVED: ["פעילה – מאושרת", "good"], PENDING_APPROVAL: ["ממתינה לאישור", "warn"], REJECTED: ["נדחתה", "bad"], PAUSED: ["מושהית", "warn"], DISABLED: ["מושבתת", "bad"], DRAFT: ["טיוטה / לא נתמכת", "neutral"] };

/** WhatsApp templates: search, table, WhatsApp preview of the selected template, rename (display name in the app). */
export function WhatsAppTemplatesScreen({ templates, canEdit, businessName, actions }: { templates: TemplateRow[]; canEdit: boolean; businessName: string; actions?: React.ReactNode }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<{ id: string; value: string } | null>(null); const [saving, setSaving] = useState(false);
  const label = (t: TemplateRow) => t.displayName?.trim() || t.name;
  const [selected, setSelected] = useState<string | null>(templates[0]?.id ?? null);
  const [builder, setBuilder] = useState(false);
  const rows = useMemo(() => { const s = q.trim().toLowerCase(); return templates.filter((t) => !s || label(t).toLowerCase().includes(s) || t.name.toLowerCase().includes(s) || t.body.toLowerCase().includes(s)); }, [templates, q]);
  async function saveName() {
    if (!edit) return; setSaving(true);
    try {
      const r = await fetch(`/api/templates/${edit.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName: edit.value.trim() || null }) });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error ?? "שמירת השם נכשלה");
      toast.success("שם התבנית עודכן"); setEdit(null); router.refresh();
    } catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  }
  const sel = templates.find((t) => t.id === selected) ?? null;
  const header = (t: TemplateRow) => (t.components ?? []).find((c) => c.type === "HEADER");
  const footer = (t: TemplateRow) => (t.components ?? []).find((c) => c.type === "FOOTER")?.text ?? null;
  const sample = (t: TemplateRow) => Object.fromEntries(t.variables.map((v) => [v, v === "h1" ? "דוגמה" : `[${v}]`]));
  return (
    <div data-testid="wa-templates">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <label className="cmp-search"><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש לפי שם או תוכן" aria-label="חיפוש תבניות" /></label>
        <div className="ms-auto flex gap-2">{actions}{canEdit && <Button onClick={() => setBuilder(true)} data-testid="tb-open">+ יצירת תבנית</Button>}</div>
      </div>
      <div className="tpl-list">
        <div className="overflow-auto rounded-md border bg-white"><table className="w-full text-sm"><thead className="text-xs text-muted"><tr><th className="text-start p-2">שם התבנית</th><th className="text-start">קטגוריה</th><th className="text-start">שפה</th><th className="text-start">סטטוס</th><th className="text-start">רכיבים</th><th className="text-start">עודכנה</th></tr></thead>
          <tbody>{rows.map((t) => { const [statusLabel, tone] = STATUS[t.status] ?? [t.status, "neutral"]; return (
            <tr key={t.id} className="tpl-row border-t" aria-selected={selected === t.id} onClick={() => setSelected(t.id)} data-testid={`tpl-${t.id}`}>
              <td className="p-2 font-medium"><span data-testid={`tpl-name-${t.id}`}>{label(t)}</span>{label(t) !== t.name && <div className="text-[11px] text-muted" dir="ltr">{t.name}</div>}{t.syncError && <div className="text-[11px] text-warn" dir="rtl">{t.syncError}</div>}</td>
              <td>{CATEGORY[t.category] ?? t.category}</td><td>{TEMPLATE_LANGUAGES[t.language] ?? t.language}</td><td><Badge tone={tone} dot>{statusLabel}</Badge></td>
              <td className="text-xs text-muted">{[t.headerFormat ? `כותרת ${t.headerFormat === "TEXT" ? "טקסט" : t.headerFormat.toLowerCase()}` : null, t.variables.length ? `${t.variables.length} משתנים` : null, t.buttons?.length ? `${t.buttons.length} כפתורים` : null].filter(Boolean).join(" · ") || "טקסט"}</td>
              <td className="text-xs">{new Date(t.updatedAt).toLocaleDateString("he-IL")}</td>
            </tr>); })}
            {!rows.length && <tr><td colSpan={6} className="p-6 text-center text-muted">אין תבניות {templates.length ? "שמתאימות לסינון" : "עדיין – צור תבנית או סנכרן מ-Meta"}</td></tr>}
          </tbody></table></div>
        <aside className="space-y-2" data-testid="tpl-preview">{sel ? <><div className="flex items-center justify-between gap-2">{edit?.id === sel.id
            ? <form className="flex flex-1 items-center gap-1" onSubmit={(e) => { e.preventDefault(); void saveName(); }}><input autoFocus className="cmp-input flex-1" value={edit.value} maxLength={120} onChange={(e) => setEdit({ ...edit, value: e.target.value })} aria-label="שם התבנית" data-testid="tpl-rename-input" /><Button size="sm" type="submit" loading={saving} data-testid="tpl-rename-save">שמור</Button><Button size="sm" variant="ghost" type="button" onClick={() => setEdit(null)}>ביטול</Button></form>
            : <span className="flex items-center gap-1"><b>{label(sel)}</b>{canEdit && <button type="button" className="text-muted hover:text-fg" title="עריכת שם" aria-label="עריכת שם התבנית" onClick={() => setEdit({ id: sel.id, value: label(sel) })} data-testid="tpl-rename"><Pencil size={14} /></button>}</span>}<Badge tone={(STATUS[sel.status] ?? ["", "neutral"])[1]}>{(STATUS[sel.status] ?? [sel.status])[0]}</Badge></div>
          {edit?.id === sel.id && <p className="text-[11px] text-muted">השם מתעדכן בכל המערכת. השם אצל Meta (<span dir="ltr">{sel.name}</span>) לא משתנה – Meta לא מאפשרת לשנות שם של תבנית קיימת.</p>}
          <WhatsAppPreview businessName={businessName} model={{ headerFormat: sel.headerFormat, headerText: header(sel)?.text ?? null, body: sel.body, footer: footer(sel), buttons: sel.buttons ?? [], values: sample(sel) }} />
          <p className="text-[11px] text-muted text-center">משתנים מוצגים כ-[1], [2]… ומוחלפים בערכים בזמן השליחה</p></> : <p className="text-sm text-muted">בחר תבנית לתצוגה מקדימה</p>}</aside>
      </div>
      {builder && <TemplateBuilder businessName={businessName} onClose={() => setBuilder(false)} />}
    </div>
  );
}
