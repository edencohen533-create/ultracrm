"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Search } from "lucide-react";
import { toast } from "sonner";
import { Badge, Button } from "@/components/ui";
import { TEMPLATE_LANGUAGES } from "@/lib/validation/template";
import { TemplateBuilder } from "./TemplateBuilder";
import { WhatsAppPreview, type PreviewButton } from "./WhatsAppPreview";
import { useT } from "@/components/i18n/LangProvider";

export interface TemplateRow { id: string; name: string; displayName?: string | null; language: string; category: string; status: string; body: string; variables: string[]; headerFormat: string | null; buttons: PreviewButton[] | null; components: Array<{ type?: string; text?: string; format?: string }> | null; syncError: string | null; updatedAt: string }
const CATEGORY: Record<string, [string, string]> = { MARKETING: ["שיווק", "Marketing"], UTILITY: ["שירות", "Utility"], AUTHENTICATION: ["אימות", "Authentication"] };
const STATUS: Record<string, [string, "good" | "warn" | "bad" | "neutral", string]> = { APPROVED: ["פעילה – מאושרת", "good", "Active – approved"], PENDING_APPROVAL: ["ממתינה לאישור", "warn", "Pending approval"], REJECTED: ["נדחתה", "bad", "Rejected"], PAUSED: ["מושהית", "warn", "Paused"], DISABLED: ["מושבתת", "bad", "Disabled"], DRAFT: ["טיוטה / לא נתמכת", "neutral", "Draft / unsupported"] };

/** WhatsApp templates: search, table, WhatsApp preview of the selected template, rename (display name in the app). */
export function WhatsAppTemplatesScreen({ templates, canEdit, businessName, actions }: { templates: TemplateRow[]; canEdit: boolean; businessName: string; actions?: React.ReactNode }) {
  const t = useT();
  const router = useRouter();
  const statusText = (status: string) => { const s = STATUS[status]; return s ? t(s[0], s[2]) : status; };
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<{ id: string; value: string } | null>(null); const [saving, setSaving] = useState(false);
  const label = (tpl: TemplateRow) => tpl.displayName?.trim() || tpl.name;
  const [selected, setSelected] = useState<string | null>(templates[0]?.id ?? null);
  const [builder, setBuilder] = useState(false);
  const rows = useMemo(() => { const s = q.trim().toLowerCase(); return templates.filter((tpl) => !s || label(tpl).toLowerCase().includes(s) || tpl.name.toLowerCase().includes(s) || tpl.body.toLowerCase().includes(s)); }, [templates, q]);
  async function saveName() {
    if (!edit) return; setSaving(true);
    try {
      const r = await fetch(`/api/templates/${edit.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName: edit.value.trim() || null }) });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error ?? t("שמירת השם נכשלה", "Failed to save the name"));
      toast.success(t("שם התבנית עודכן", "Template name updated")); setEdit(null); router.refresh();
    } catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  }
  const sel = templates.find((tpl) => tpl.id === selected) ?? null;
  const header = (tpl: TemplateRow) => (tpl.components ?? []).find((c) => c.type === "HEADER");
  const footer = (tpl: TemplateRow) => (tpl.components ?? []).find((c) => c.type === "FOOTER")?.text ?? null;
  const sample = (tpl: TemplateRow) => Object.fromEntries(tpl.variables.map((v) => [v, v === "h1" ? t("דוגמה", "Sample") : `[${v}]`]));
  return (
    <div data-testid="wa-templates">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <label className="cmp-search"><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("חיפוש לפי שם או תוכן", "Search by name or content")} aria-label={t("חיפוש תבניות", "Search templates")} /></label>
        <div className="ms-auto flex gap-2">{actions}{canEdit && <Button onClick={() => setBuilder(true)} data-testid="tb-open">{t("+ יצירת תבנית", "+ New template")}</Button>}</div>
      </div>
      <div className="tpl-list">
        <div className="overflow-auto rounded-md border bg-white"><table className="w-full text-sm"><thead className="text-xs text-muted"><tr><th className="text-start p-2">{t("שם התבנית", "Template name")}</th><th className="text-start">{t("קטגוריה", "Category")}</th><th className="text-start">{t("שפה", "Language")}</th><th className="text-start">{t("סטטוס", "Status")}</th><th className="text-start">{t("רכיבים", "Components")}</th><th className="text-start">{t("עודכנה", "Updated")}</th></tr></thead>
          <tbody>{rows.map((tpl) => { const tone = STATUS[tpl.status]?.[1] ?? "neutral"; const statusLabel = statusText(tpl.status); return (
            <tr key={tpl.id} className="tpl-row border-t" aria-selected={selected === tpl.id} onClick={() => setSelected(tpl.id)} data-testid={`tpl-${tpl.id}`}>
              <td className="p-2 font-medium"><span data-testid={`tpl-name-${tpl.id}`}>{label(tpl)}</span>{label(tpl) !== tpl.name && <div className="text-[11px] text-muted" dir="ltr">{tpl.name}</div>}{tpl.syncError && <div className="text-[11px] text-warn" dir="auto">{tpl.syncError}</div>}</td>
              <td>{CATEGORY[tpl.category] ? t(CATEGORY[tpl.category][0], CATEGORY[tpl.category][1]) : tpl.category}</td><td>{TEMPLATE_LANGUAGES[tpl.language] ?? tpl.language}</td><td><Badge tone={tone} dot>{statusLabel}</Badge></td>
              <td className="text-xs text-muted">{[tpl.headerFormat ? t(`כותרת ${tpl.headerFormat === "TEXT" ? "טקסט" : tpl.headerFormat.toLowerCase()}`, `${tpl.headerFormat === "TEXT" ? "Text" : tpl.headerFormat.toLowerCase()} header`) : null, tpl.variables.length ? t(`${tpl.variables.length} משתנים`, `${tpl.variables.length} variables`) : null, tpl.buttons?.length ? t(`${tpl.buttons.length} כפתורים`, `${tpl.buttons.length} buttons`) : null].filter(Boolean).join(" · ") || t("טקסט", "Text")}</td>
              <td className="text-xs">{new Date(tpl.updatedAt).toLocaleDateString(t.lang === "en" ? "en-GB" : "he-IL")}</td>
            </tr>); })}
            {!rows.length && <tr><td colSpan={6} className="p-6 text-center text-muted">{templates.length ? t("אין תבניות שמתאימות לסינון", "No templates match the filter") : t("אין תבניות עדיין – צור תבנית או סנכרן מ-Meta", "No templates yet – create one or sync from Meta")}</td></tr>}
          </tbody></table></div>
        <aside className="space-y-2" data-testid="tpl-preview">{sel ? <><div className="flex items-center justify-between gap-2">{edit?.id === sel.id
            ? <form className="flex flex-1 items-center gap-1" onSubmit={(e) => { e.preventDefault(); void saveName(); }}><input autoFocus className="cmp-input flex-1" value={edit.value} maxLength={120} onChange={(e) => setEdit({ ...edit, value: e.target.value })} aria-label={t("שם התבנית", "Template name")} data-testid="tpl-rename-input" /><Button size="sm" type="submit" loading={saving} data-testid="tpl-rename-save">{t("שמור", "Save")}</Button><Button size="sm" variant="ghost" type="button" onClick={() => setEdit(null)}>{t("ביטול", "Cancel")}</Button></form>
            : <span className="flex items-center gap-1"><b>{label(sel)}</b>{canEdit && <button type="button" className="text-muted hover:text-fg" title={t("עריכת שם", "Rename")} aria-label={t("עריכת שם התבנית", "Rename template")} onClick={() => setEdit({ id: sel.id, value: label(sel) })} data-testid="tpl-rename"><Pencil size={14} /></button>}</span>}<Badge tone={STATUS[sel.status]?.[1] ?? "neutral"}>{statusText(sel.status)}</Badge></div>
          {edit?.id === sel.id && <p className="text-[11px] text-muted">{t("השם מתעדכן בכל המערכת. השם אצל Meta (", "The name updates across the app. The name at Meta (")}<span dir="ltr">{sel.name}</span>{t(") לא משתנה – Meta לא מאפשרת לשנות שם של תבנית קיימת.", ") does not change – Meta does not allow renaming an existing template.")}</p>}
          <WhatsAppPreview businessName={businessName} model={{ headerFormat: sel.headerFormat, headerText: header(sel)?.text ?? null, body: sel.body, footer: footer(sel), buttons: sel.buttons ?? [], values: sample(sel) }} />
          <p className="text-[11px] text-muted text-center">{t("משתנים מוצגים כ-[1], [2]… ומוחלפים בערכים בזמן השליחה", "Variables are shown as [1], [2]… and replaced with real values when sending")}</p></> : <p className="text-sm text-muted">{t("בחר תבנית לתצוגה מקדימה", "Select a template to preview")}</p>}</aside>
      </div>
      {builder && <TemplateBuilder businessName={businessName} onClose={() => setBuilder(false)} />}
    </div>
  );
}
