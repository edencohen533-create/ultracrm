"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { TEMPLATE_LANGUAGES } from "@/lib/validation/template";
import { TemplateBuilder } from "./TemplateBuilder";
import { WhatsAppPreview, type PreviewButton } from "./WhatsAppPreview";

export interface TemplateRow { id: string; name: string; language: string; category: string; status: string; body: string; variables: string[]; headerFormat: string | null; buttons: PreviewButton[] | null; components: Array<{ type?: string; text?: string; format?: string }> | null; syncError: string | null; updatedAt: string }
const CATEGORY: Record<string, string> = { MARKETING: "שיווק", UTILITY: "שירות", AUTHENTICATION: "אימות" };
const STATUS: Record<string, [string, "good" | "warn" | "bad" | "neutral"]> = { APPROVED: ["פעילה – מאושרת", "good"], PENDING_APPROVAL: ["ממתינה לאישור", "warn"], REJECTED: ["נדחתה", "bad"], PAUSED: ["מושהית", "warn"], DISABLED: ["מושבתת", "bad"], DRAFT: ["טיוטה / לא נתמכת", "neutral"] };

/** Message templates like Meta's manager: search + filters, table, and a WhatsApp preview of the selected template. */
export function WhatsAppTemplatesScreen({ templates, canEdit, businessName, actions }: { templates: TemplateRow[]; canEdit: boolean; businessName: string; actions?: React.ReactNode }) {
  const [q, setQ] = useState(""); const [status, setStatus] = useState(""); const [category, setCategory] = useState(""); const [language, setLanguage] = useState("");
  const [selected, setSelected] = useState<string | null>(templates[0]?.id ?? null);
  const [builder, setBuilder] = useState(false);
  const rows = useMemo(() => templates.filter((t) => (!q || t.name.includes(q.toLowerCase()) || t.body.includes(q)) && (!status || t.status === status) && (!category || t.category === category) && (!language || t.language === language)), [templates, q, status, category, language]);
  const sel = templates.find((t) => t.id === selected) ?? null;
  const header = (t: TemplateRow) => (t.components ?? []).find((c) => c.type === "HEADER");
  const footer = (t: TemplateRow) => (t.components ?? []).find((c) => c.type === "FOOTER")?.text ?? null;
  const sample = (t: TemplateRow) => Object.fromEntries(t.variables.map((v) => [v, v === "h1" ? "דוגמה" : `[${v}]`]));
  return (
    <div data-testid="wa-templates">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <label className="cmp-search"><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש לפי שם או תוכן" aria-label="חיפוש תבניות" /></label>
        <select className="cmp-input" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="קטגוריה"><option value="">כל הקטגוריות</option>{Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select className="cmp-input" value={language} onChange={(e) => setLanguage(e.target.value)} aria-label="שפה"><option value="">כל השפות</option>{[...new Set(templates.map((t) => t.language))].map((l) => <option key={l} value={l}>{TEMPLATE_LANGUAGES[l] ?? l}</option>)}</select>
        <select className="cmp-input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="סטטוס"><option value="">כל הסטטוסים</option>{Object.entries(STATUS).map(([k, [v]]) => <option key={k} value={k}>{v}</option>)}</select>
        <div className="ms-auto flex gap-2">{actions}{canEdit && <Button onClick={() => setBuilder(true)} data-testid="tb-open">+ יצירת תבנית</Button>}</div>
      </div>
      <div className="tpl-list">
        <div className="overflow-auto rounded-md border bg-white"><table className="w-full text-sm"><thead className="text-xs text-muted"><tr><th className="text-start p-2">שם התבנית</th><th className="text-start">קטגוריה</th><th className="text-start">שפה</th><th className="text-start">סטטוס</th><th className="text-start">רכיבים</th><th className="text-start">עודכנה</th></tr></thead>
          <tbody>{rows.map((t) => { const [label, tone] = STATUS[t.status] ?? [t.status, "neutral"]; return (
            <tr key={t.id} className="tpl-row border-t" aria-selected={selected === t.id} onClick={() => setSelected(t.id)} data-testid={`tpl-${t.id}`}>
              <td className="p-2 font-medium" dir="ltr">{t.name}{t.syncError && <div className="text-[11px] text-warn" dir="rtl">{t.syncError}</div>}</td>
              <td>{CATEGORY[t.category] ?? t.category}</td><td>{TEMPLATE_LANGUAGES[t.language] ?? t.language}</td><td><Badge tone={tone} dot>{label}</Badge></td>
              <td className="text-xs text-muted">{[t.headerFormat ? `כותרת ${t.headerFormat === "TEXT" ? "טקסט" : t.headerFormat.toLowerCase()}` : null, t.variables.length ? `${t.variables.length} משתנים` : null, t.buttons?.length ? `${t.buttons.length} כפתורים` : null].filter(Boolean).join(" · ") || "טקסט"}</td>
              <td className="text-xs">{new Date(t.updatedAt).toLocaleDateString("he-IL")}</td>
            </tr>); })}
            {!rows.length && <tr><td colSpan={6} className="p-6 text-center text-muted">אין תבניות {templates.length ? "שמתאימות לסינון" : "עדיין – צור תבנית או סנכרן מ-Meta"}</td></tr>}
          </tbody></table></div>
        <aside className="space-y-2" data-testid="tpl-preview">{sel ? <><div className="flex items-center justify-between"><b dir="ltr">{sel.name}</b><Badge tone={(STATUS[sel.status] ?? ["", "neutral"])[1]}>{(STATUS[sel.status] ?? [sel.status])[0]}</Badge></div>
          <WhatsAppPreview businessName={businessName} model={{ headerFormat: sel.headerFormat, headerText: header(sel)?.text ?? null, body: sel.body, footer: footer(sel), buttons: sel.buttons ?? [], values: sample(sel) }} />
          <p className="text-[11px] text-muted text-center">משתנים מוצגים כ-[1], [2]… ומוחלפים בערכים בזמן השליחה</p></> : <p className="text-sm text-muted">בחר תבנית לתצוגה מקדימה</p>}</aside>
      </div>
      {builder && <TemplateBuilder businessName={businessName} onClose={() => setBuilder(false)} />}
    </div>
  );
}
