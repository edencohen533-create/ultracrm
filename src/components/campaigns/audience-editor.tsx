"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { defaultAudience, type AudienceNode, type AudienceRule } from "@/lib/audiences";
export interface AudienceOptions { tags: { id: string; name: string }[]; agents: { id: string; name: string }[]; campaigns: { id: string; name: string }[] }
const selectClass = "min-w-0 w-full rounded border bg-background p-2 text-sm";
const fields: { value: AudienceRule["field"]; label: string }[] = [
  { value: "tag", label: "תגית" }, { value: "source", label: "מקור ליד" }, { value: "custom", label: "שדה מותאם" }, { value: "agent", label: "נציג משויך בשיחה" }, { value: "owner", label: "אחראי CRM" }, { value: "leadStatus", label: "שלב ליד" },
  { value: "consent", label: "הסכמה לדיוור" }, { value: "blocked", label: "חסימה מלאה" }, { value: "marketingEligible", label: "זכאות שיווקית כעת" },
  { value: "lastMessage", label: "הודעה אחרונה" }, { value: "lastInbound", label: "תגובה אחרונה מהלקוח" }, { value: "lastOutbound", label: "הודעה אחרונה ללקוח" }, { value: "campaign", label: "השתתפות בקמפיין" },
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
  const choices = rule.field === "tag" ? options.tags : rule.field === "agent" ? options.agents : rule.field === "campaign" ? options.campaigns : null;
  return <div className="grid min-w-0 gap-2 sm:grid-cols-2">
    <select className={selectClass} aria-label={`סוג תנאי ${path}`} value={rule.field} onChange={(event) => onChange(freshRule(event.target.value as AudienceRule["field"]))}>{fields.map((field) => <option key={field.value} value={field.value}>{field.label}</option>)}</select>
    {rule.field === "tag" && <select className={selectClass} aria-label={`השוואה ${path}`} value={rule.operator} onChange={(event) => onChange({ ...rule, operator: event.target.value as "is" | "is_not" })}><option value="is">כולל תגית</option><option value="is_not">ללא תגית</option></select>}
    {(rule.field === "owner" || rule.field === "leadStatus") && <select className={selectClass} aria-label={`השוואה ${path}`} value={rule.operator} onChange={(event) => onChange({ ...rule, operator: event.target.value as "is" | "is_not" })}><option value="is">הוא</option><option value="is_not">אינו</option></select>}
    {rule.field === "owner" && <select className={selectClass} aria-label={`ערך תנאי ${path}`} value={rule.value ?? ""} onChange={(event) => onChange({ ...rule, value: event.target.value || null })}><option value="">ללא אחראי</option>{options.agents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
    {rule.field === "leadStatus" && <select className={selectClass} aria-label={`ערך תנאי ${path}`} value={rule.value} onChange={(event) => onChange({ ...rule, value: event.target.value as typeof rule.value })}>{Object.entries({ new: "ליד חדש", contacted: "נוצר קשר", qualified: "ליד מתאים", unqualified: "לא רלוונטי", converted: "הומר לעסקה", none: "ללא ליד" }).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}
    {(rule.field === "custom" || rule.field === "source") && <select className={selectClass} aria-label={`השוואה ${path}`} value={rule.operator} onChange={(event) => onChange({ ...rule, operator: event.target.value as "equals" | "contains" })}><option value="equals">שווה ל־</option><option value="contains">מכיל</option></select>}
    {rule.field === "custom" && <Input maxLength={200} aria-label={`שם שדה ${path}`} placeholder="שם השדה כפי שנשמר בכרטיס הלקוח" value={rule.key} onChange={(event) => onChange({ ...rule, key: event.target.value })} />}
    {(rule.field === "custom" || rule.field === "source") && <Input maxLength={200} aria-label={`ערך תנאי ${path}`} value={rule.value} onChange={(event) => onChange({ ...rule, value: event.target.value })} />}
    {choices && (rule.field === "tag" || rule.field === "agent" || rule.field === "campaign") && <select className={selectClass} aria-label={`ערך תנאי ${path}`} value={rule.value} onChange={(event) => onChange({ ...rule, value: event.target.value })}><option value="">בחר...</option>{choices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
    {rule.field === "campaign" && <select className={selectClass} aria-label={`תוצאת קמפיין ${path}`} value={rule.result} onChange={(event) => onChange({ ...rule, result: event.target.value as typeof rule.result })}>{Object.entries({ ANY: "כל משתתף", QUEUED: "ממתין", PROCESSING: "בטיפול", SENT: "התקבל אצל הספק", FAILED: "נכשל", SKIPPED: "דולג או הוחרג", UNKNOWN: "תוצאה לא ודאית" }).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>}
    {rule.field === "consent" && <select className={selectClass} aria-label={`ערך תנאי ${path}`} value={rule.value} onChange={(event) => onChange({ ...rule, value: event.target.value as typeof rule.value })}><option value="OPTED_IN">מסכים לדיוור</option><option value="OPTED_OUT">הוסר מדיוור</option><option value="UNKNOWN">לא תועדה הסכמה</option></select>}
    {(rule.field === "blocked" || rule.field === "marketingEligible") && <select className={selectClass} aria-label={`ערך תנאי ${path}`} value={String(rule.value)} onChange={(event) => onChange({ ...rule, value: event.target.value === "true" })}><option value="true">כן</option><option value="false">לא</option></select>}
    {["lastMessage", "lastInbound", "lastOutbound"].includes(rule.field) && "operator" in rule && (rule.field === "lastMessage" || rule.field === "lastInbound" || rule.field === "lastOutbound") && <>
      <select className={selectClass} aria-label={`השוואה ${path}`} value={rule.operator} onChange={(event) => onChange({ ...rule, operator: event.target.value as "before" | "after" | "never" })}><option value="never">אין הודעה כזו</option><option value="before">לפני התאריך</option><option value="after">בתאריך או אחריו</option></select>
      {rule.operator !== "never" && <label className="text-xs">תאריך באזור הזמן המקומי<Input aria-label={`תאריך תנאי ${path}`} type="date" value={dateValue(rule.value)} onChange={(event) => onChange({ ...rule, value: event.target.value ? new Date(`${event.target.value}T00:00:00`).toISOString() : undefined })} /></label>}
    </>}
  </div>;
}
export function AudienceEditor({ value, onChange, options, path = "1", depth = 0 }: { value: AudienceNode; onChange: (value: AudienceNode) => void; options: AudienceOptions; path?: string; depth?: number }) {
  if (!("conditions" in value)) return <RuleEditor rule={value} onChange={onChange} options={options} path={path} />;
  return <fieldset className="min-w-0 space-y-3 rounded border p-3"><legend className="px-1 text-sm">קבוצת תנאים {path}</legend>
    <select aria-label={`חיבור תנאים ${path}`} className={selectClass} value={value.operator} onChange={(event) => onChange({ ...value, operator: event.target.value as "AND" | "OR" })}><option value="AND">כל התנאים מתקיימים (AND)</option><option value="OR">לפחות תנאי אחד מתקיים (OR)</option></select>
    {value.conditions.map((node, i) => <div className="min-w-0 space-y-1 rounded bg-muted/30 p-2" key={i}><AudienceEditor options={options} value={node} path={`${path}.${i + 1}`} depth={depth + 1} onChange={(changed) => onChange({ ...value, conditions: value.conditions.map((old, index) => index === i ? changed : old) })} /><Button size="sm" variant="ghost" disabled={value.conditions.length === 1} onClick={() => onChange({ ...value, conditions: value.conditions.filter((_, index) => index !== i) })}>הסר תנאי {path}.{i + 1}</Button></div>)}
    <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={value.conditions.length >= 20} onClick={() => onChange({ ...value, conditions: [...value.conditions, freshRule("consent")] })}>הוסף תנאי לקבוצה {path}</Button>{depth < 2 && <Button size="sm" variant="outline" disabled={value.conditions.length >= 20} onClick={() => onChange({ ...value, conditions: [...value.conditions, defaultAudience()] })}>הוסף קבוצת משנה {path}</Button>}</div>
  </fieldset>;
}
export function AudiencePreview({ segment, listId, excludedListIds = [] }: { segment?: AudienceNode; listId?: string; excludedListIds?: string[] }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ matched: number; excluded: number; eligible: number; ineligible: number; checkedAt: string; samples: { name: string; phone: string }[] } | null>(null);
  const [checkedInput, setCheckedInput] = useState("");
  const currentInput = JSON.stringify(segment ? { segment } : { listId, excludedListIds });
  const visible = checkedInput === currentInput ? result : null;
  return <div className="space-y-2"><Button variant="outline" disabled={busy || (!segment && !listId)} onClick={async () => {
    setBusy(true); setResult(null);
    try { const response = await fetch("/api/distribution-lists/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: currentInput }); const data = await response.json(); if (!response.ok) throw new Error(data.error); setCheckedInput(currentInput); setResult(data); } catch (error) { toast.error(error instanceof Error ? error.message : "בדיקת הקהל נכשלה"); } finally { setBusy(false); }
  }}>{busy ? "סופר נמענים..." : "בדוק קהל וזכאות"}</Button>{visible && <div role="status" className="space-y-1 text-sm"><p>{visible.matched} מתאימים לתנאים; {visible.excluded} הוחרגו; {visible.eligible} זכאים לדיוור כעת; {visible.ineligible} ללא זכאות כרגע.</p><p>{visible.matched > 10000 ? "הקהל גדול מ־10,000 אנשי קשר. יש לצמצם אותו לפני יצירת קמפיין." : ""}</p><p>נבדק: {new Date(visible.checkedAt).toLocaleString("he-IL")}. הזכאות אינה מבטיחה אישור ספק ונבדקת שוב בשליחה.</p>{visible.samples.map((sample, i) => <p key={i} className="break-words">{sample.name} · <span dir="ltr">{sample.phone}</span></p>)}</div>}</div>;
}
