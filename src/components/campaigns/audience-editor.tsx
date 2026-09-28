"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/components/i18n/LangProvider";
import { defaultAudience, type AudienceNode, type AudienceRule } from "@/lib/audiences";
export interface AudienceOptions { tags: { id: string; name: string }[]; agents: { id: string; name: string }[]; campaigns: { id: string; name: string }[] }
const selectClass = "min-w-0 w-full rounded border bg-background p-2 text-sm";
const fields: { value: AudienceRule["field"]; label: string; en: string }[] = [
  { value: "tag", label: "תגית", en: "Tag" }, { value: "source", label: "מקור ליד", en: "Lead source" }, { value: "custom", label: "שדה מותאם", en: "Custom field" }, { value: "agent", label: "נציג משויך בשיחה", en: "Agent assigned to conversation" }, { value: "owner", label: "אחראי CRM", en: "CRM owner" }, { value: "leadStatus", label: "שלב ליד", en: "Lead stage" },
  { value: "consent", label: "הסכמה לדיוור", en: "Marketing consent" }, { value: "blocked", label: "חסימה מלאה", en: "Fully blocked" }, { value: "marketingEligible", label: "זכאות שיווקית כעת", en: "Currently marketing-eligible" },
  { value: "lastMessage", label: "הודעה אחרונה", en: "Last message" }, { value: "lastInbound", label: "תגובה אחרונה מהלקוח", en: "Last reply from customer" }, { value: "lastOutbound", label: "הודעה אחרונה ללקוח", en: "Last message to customer" }, { value: "campaign", label: "השתתפות בקמפיין", en: "Campaign participation" },
];
function freshRule(field: AudienceRule["field"]): AudienceRule {
  if (field === "consent") return { field, operator: "is", value: "OPTED_IN" };
  if (field === "blocked" || field === "marketingEligible") return { field, operator: "is", value: field === "marketingEligible" };
  if (field === "custom") return { field, operator: "equals", key: "", value: "" };
  if (field === "source") return { field, operator: "equals", value: "" };
  if (field === "campaign") return { field, operator: "is", value: "", result: "ANY" };
  if (field === "tag" || field === "agent") return { field, operator: "is", value: "" };
  if (field === "owner") return { field, operator: "is", value: null };
  if (field === "leadStatus") return { field, operator: "is", value: "new" };
  return { field, operator: "never" };
}
function dateValue(value?: string) { if (!value) return ""; const d = new Date(value); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function RuleEditor({ rule, onChange, options, path }: { rule: AudienceRule; onChange: (rule: AudienceRule) => void; options: AudienceOptions; path: string }) {
  const t = useT();
  const choices = rule.field === "tag" ? options.tags : rule.field === "agent" ? options.agents : rule.field === "campaign" ? options.campaigns : null;
  return <div className="grid min-w-0 gap-2 sm:grid-cols-2">
    <select className={selectClass} aria-label={t(`סוג תנאי ${path}`, `Condition type ${path}`)} value={rule.field} onChange={(event) => onChange(freshRule(event.target.value as AudienceRule["field"]))}>{fields.map((field) => <option key={field.value} value={field.value}>{t(field.label, field.en)}</option>)}</select>
    {rule.field === "tag" && <select className={selectClass} aria-label={t(`השוואה ${path}`, `Comparison ${path}`)} value={rule.operator} onChange={(event) => onChange({ ...rule, operator: event.target.value as "is" | "is_not" })}><option value="is">{t("כולל תגית", "Has tag")}</option><option value="is_not">{t("ללא תגית", "Without tag")}</option></select>}
    {(rule.field === "owner" || rule.field === "leadStatus") && <select className={selectClass} aria-label={t(`השוואה ${path}`, `Comparison ${path}`)} value={rule.operator} onChange={(event) => onChange({ ...rule, operator: event.target.value as "is" | "is_not" })}><option value="is">{t("הוא", "Is")}</option><option value="is_not">{t("אינו", "Is not")}</option></select>}
    {rule.field === "owner" && <select className={selectClass} aria-label={t(`ערך תנאי ${path}`, `Condition value ${path}`)} value={rule.value ?? ""} onChange={(event) => onChange({ ...rule, value: event.target.value || null })}><option value="">{t("ללא אחראי", "No owner")}</option>{options.agents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
    {rule.field === "leadStatus" && <select className={selectClass} aria-label={t(`ערך תנאי ${path}`, `Condition value ${path}`)} value={rule.value} onChange={(event) => onChange({ ...rule, value: event.target.value as typeof rule.value })}>{Object.entries({ new: t("ליד חדש", "New lead"), contacted: t("נוצר קשר", "Contacted"), qualified: t("ליד מתאים", "Qualified"), unqualified: t("לא רלוונטי", "Unqualified"), converted: t("הומר לעסקה", "Converted to deal"), none: t("ללא ליד", "No lead") }).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}
    {(rule.field === "custom" || rule.field === "source") && <select className={selectClass} aria-label={t(`השוואה ${path}`, `Comparison ${path}`)} value={rule.operator} onChange={(event) => onChange({ ...rule, operator: event.target.value as "equals" | "contains" })}><option value="equals">{t("שווה ל־", "Equals")}</option><option value="contains">{t("מכיל", "Contains")}</option></select>}
    {rule.field === "custom" && <Input maxLength={200} aria-label={t(`שם שדה ${path}`, `Field name ${path}`)} placeholder={t("שם השדה כפי שנשמר בכרטיס הלקוח", "Field name as saved on the contact card")} value={rule.key} onChange={(event) => onChange({ ...rule, key: event.target.value })} />}
    {(rule.field === "custom" || rule.field === "source") && <Input maxLength={200} aria-label={t(`ערך תנאי ${path}`, `Condition value ${path}`)} value={rule.value} onChange={(event) => onChange({ ...rule, value: event.target.value })} />}
    {choices && (rule.field === "tag" || rule.field === "agent" || rule.field === "campaign") && <select className={selectClass} aria-label={t(`ערך תנאי ${path}`, `Condition value ${path}`)} value={rule.value} onChange={(event) => onChange({ ...rule, value: event.target.value })}><option value="">{t("בחר...", "Select...")}</option>{choices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
    {rule.field === "campaign" && <select className={selectClass} aria-label={t(`תוצאת קמפיין ${path}`, `Campaign result ${path}`)} value={rule.result} onChange={(event) => onChange({ ...rule, result: event.target.value as typeof rule.result })}>{Object.entries({ ANY: t("כל משתתף", "Any participant"), QUEUED: t("ממתין", "Queued"), PROCESSING: t("בטיפול", "Processing"), SENT: t("התקבל אצל הספק", "Accepted by provider"), DELIVERED: t("נמסר (לפי הספק)", "Delivered (per provider)"), READ: t("נקרא (לפי הספק)", "Read (per provider)"), REPLIED: t("השיב אחרי הקמפיין", "Replied after campaign"), NOT_DELIVERED: t("לא נמסר / נכשל", "Not delivered / failed"), FAILED: t("נכשל", "Failed"), SKIPPED: t("דולג או הוחרג", "Skipped or excluded"), UNKNOWN: t("תוצאה לא ודאית", "Uncertain result") }).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>}
    {rule.field === "consent" && <select className={selectClass} aria-label={t(`ערך תנאי ${path}`, `Condition value ${path}`)} value={rule.value} onChange={(event) => onChange({ ...rule, value: event.target.value as typeof rule.value })}><option value="OPTED_IN">{t("מסכים לדיוור", "Opted in")}</option><option value="OPTED_OUT">{t("הוסר מדיוור", "Opted out")}</option><option value="UNKNOWN">{t("לא תועדה הסכמה", "No consent recorded")}</option></select>}
    {(rule.field === "blocked" || rule.field === "marketingEligible") && <select className={selectClass} aria-label={t(`ערך תנאי ${path}`, `Condition value ${path}`)} value={String(rule.value)} onChange={(event) => onChange({ ...rule, value: event.target.value === "true" })}><option value="true">{t("כן", "Yes")}</option><option value="false">{t("לא", "No")}</option></select>}
    {["lastMessage", "lastInbound", "lastOutbound"].includes(rule.field) && "operator" in rule && (rule.field === "lastMessage" || rule.field === "lastInbound" || rule.field === "lastOutbound") && <>
      <select className={selectClass} aria-label={t(`השוואה ${path}`, `Comparison ${path}`)} value={rule.operator} onChange={(event) => onChange({ ...rule, operator: event.target.value as "before" | "after" | "never" })}><option value="never">{t("אין הודעה כזו", "No such message")}</option><option value="before">{t("לפני התאריך", "Before date")}</option><option value="after">{t("בתאריך או אחריו", "On or after date")}</option></select>
      {rule.operator !== "never" && <label className="text-xs">{t("תאריך באזור הזמן המקומי", "Date in local time zone")}<Input aria-label={t(`תאריך תנאי ${path}`, `Condition date ${path}`)} type="date" value={dateValue(rule.value)} onChange={(event) => onChange({ ...rule, value: event.target.value ? new Date(`${event.target.value}T00:00:00`).toISOString() : undefined })} /></label>}
    </>}
  </div>;
}
export function AudienceEditor({ value, onChange, options, path = "1", depth = 0 }: { value: AudienceNode; onChange: (value: AudienceNode) => void; options: AudienceOptions; path?: string; depth?: number }) {
  const t = useT();
  if (!("conditions" in value)) return <RuleEditor rule={value} onChange={onChange} options={options} path={path} />;
  return <fieldset className="min-w-0 space-y-3 rounded border p-3"><legend className="px-1 text-sm">{t(`קבוצת תנאים ${path}`, `Condition group ${path}`)}</legend>
    <select aria-label={t(`חיבור תנאים ${path}`, `Condition logic ${path}`)} className={selectClass} value={value.operator} onChange={(event) => onChange({ ...value, operator: event.target.value as "AND" | "OR" })}><option value="AND">{t("כל התנאים מתקיימים (AND)", "All conditions match (AND)")}</option><option value="OR">{t("לפחות תנאי אחד מתקיים (OR)", "At least one condition matches (OR)")}</option></select>
    {value.conditions.map((node, i) => <div className="min-w-0 space-y-1 rounded bg-muted/30 p-2" key={i}><AudienceEditor options={options} value={node} path={`${path}.${i + 1}`} depth={depth + 1} onChange={(changed) => onChange({ ...value, conditions: value.conditions.map((old, index) => index === i ? changed : old) })} /><Button size="sm" variant="ghost" disabled={value.conditions.length === 1} onClick={() => onChange({ ...value, conditions: value.conditions.filter((_, index) => index !== i) })}>{t(`הסר תנאי ${path}.${i + 1}`, `Remove condition ${path}.${i + 1}`)}</Button></div>)}
    <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={value.conditions.length >= 20} onClick={() => onChange({ ...value, conditions: [...value.conditions, freshRule("consent")] })}>{t(`הוסף תנאי לקבוצה ${path}`, `Add condition to group ${path}`)}</Button>{depth < 2 && <Button size="sm" variant="outline" disabled={value.conditions.length >= 20} onClick={() => onChange({ ...value, conditions: [...value.conditions, defaultAudience()] })}>{t(`הוסף קבוצת משנה ${path}`, `Add subgroup ${path}`)}</Button>}</div>
  </fieldset>;
}
export function AudiencePreview({ segment, listId, excludedListIds = [] }: { segment?: AudienceNode; listId?: string; excludedListIds?: string[] }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ matched: number; excluded: number; eligible: number; ineligible: number; checkedAt: string; samples: { name: string; phone: string }[] } | null>(null);
  const [checkedInput, setCheckedInput] = useState("");
  const currentInput = JSON.stringify(segment ? { segment } : { listId, excludedListIds });
  const visible = checkedInput === currentInput ? result : null;
  return <div className="space-y-2"><Button variant="outline" disabled={busy || (!segment && !listId)} onClick={async () => {
    setBusy(true); setResult(null);
    try { const response = await fetch("/api/distribution-lists/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: currentInput }); const data = await response.json(); if (!response.ok) throw new Error(data.error); setCheckedInput(currentInput); setResult(data); } catch (error) { toast.error(error instanceof Error ? error.message : t("בדיקת הקהל נכשלה", "Audience check failed")); } finally { setBusy(false); }
  }}>{busy ? t("סופר נמענים...", "Counting recipients...") : t("בדוק קהל וזכאות", "Check audience & eligibility")}</Button>{visible && <div role="status" className="space-y-1 text-sm"><p>{t(`${visible.matched} מתאימים לתנאים; ${visible.excluded} הוחרגו; ${visible.eligible} זכאים לדיוור כעת; ${visible.ineligible} ללא זכאות כרגע.`, `${visible.matched} match the conditions; ${visible.excluded} excluded; ${visible.eligible} currently eligible for marketing; ${visible.ineligible} not eligible right now.`)}</p><p>{visible.matched > 10000 ? t("הקהל גדול מ־10,000 אנשי קשר. יש לצמצם אותו לפני יצירת קמפיין.", "The audience is larger than 10,000 contacts. Narrow it down before creating a campaign.") : ""}</p><p>{t("נבדק:", "Checked:")} {new Date(visible.checkedAt).toLocaleString(t.lang === "en" ? "en-GB" : "he-IL")}. {t("הזכאות אינה מבטיחה אישור ספק ונבדקת שוב בשליחה.", "Eligibility does not guarantee provider approval and is re-checked at send time.")}</p>{visible.samples.map((sample, i) => <p key={i} className="break-words">{sample.name} · <span dir="ltr">{sample.phone}</span></p>)}</div>}</div>;
}
