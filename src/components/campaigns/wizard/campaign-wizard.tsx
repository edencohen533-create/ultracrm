"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { CHANNEL_LABELS, templateParameterKeys, renderTemplate } from "@/lib/campaigns";
import { emailDesignSchema, renderEmailHtml, type EmailDesign } from "@/lib/email/blocks";
import { EMAIL_STARTERS } from "@/lib/email/starters";
import { smsMetrics } from "@/lib/sms";
import { mergeTagsOf } from "@/lib/merge-tags";
import { EmailEditor } from "./email-editor";

type Channel = "whatsapp" | "sms" | "email";
type Step = "info" | "audience" | "template" | "content" | "review";
interface Draft { id: string; channel: Channel; name: string; step: string; data: Record<string, unknown> & { subject?: string; preheader?: string; senderCredentialId?: string | null; senderId?: string | null; replyTo?: string | null; listIds?: string[]; excludedListIds?: string[]; templateId?: string | null; designSource?: string | null; design?: unknown; body?: string; variables?: Record<string, string>; mediaUrl?: string | null; buttonParams?: Record<string, string> | null; category?: "MARKETING" | "UTILITY"; scheduledAt?: string | null; testTo?: string }; templateId: string | null; campaignId: string | null; campaignStatus: string | null; steps: Step[] }
type Problem = { step: string; message: string };
const STEP_LABEL: Record<Step, string> = { info: "מידע", audience: "קהל יעד", template: "תבנית", content: "תוכן", review: "בקרה" };
const BUILTIN_TAGS = ["name", "first_name", "company", "city", "email", "phone", "unsubscribe_url"];

async function api<T = unknown>(url: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof d.error === "string" ? d.error : "הפעולה נכשלה");
  return d as T;
}

/** Full-screen campaign builder. Every change autosaves (debounced); steps validate lazily so the user can move around freely. */
export function CampaignWizard({ draftId }: { draftId: string }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [step, setStep] = useState<Step>("info");
  const [saveState, setSaveState] = useState<"saved" | "saving" | "dirty" | "error">("saved");
  const pending = useRef<{ name?: string; data?: Record<string, unknown> }>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api<{ draft: Draft; problems: Problem[] }>(`/api/campaigns/drafts/${draftId}`).then((r) => { setDraft(r.draft); setProblems(r.problems); setStep((r.draft.step as Step) || "info"); }).catch((e) => setError(e.message)); }, [draftId]);

  const flush = useCallback(async (extra?: { step?: Step }) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const body = { ...pending.current, ...(extra ?? {}) }; pending.current = {};
    if (!body.name && !body.data && !body.step) return;
    setSaveState("saving");
    try { const r = await api<{ draft: Draft; problems: Problem[] }>(`/api/campaigns/drafts/${draftId}`, "PATCH", body); setDraft((d) => d ? { ...r.draft, data: { ...r.draft.data } } : r.draft); setProblems(r.problems); setSaveState("saved"); }
    catch (e) { setSaveState("error"); toast.error((e as Error).message); }
  }, [draftId]);
  const patch = useCallback((data: Record<string, unknown>, name?: string) => {
    setDraft((d) => d ? { ...d, ...(name !== undefined ? { name } : {}), data: { ...d.data, ...data } } : d);
    pending.current = { ...pending.current, data: { ...(pending.current.data ?? {}), ...data }, ...(name !== undefined ? { name } : {}) };
    setSaveState("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, 700);
  }, [flush]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => { const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") return; }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, []);

  const steps = draft?.steps ?? [];
  const idx = steps.indexOf(step);
  const go = async (to: Step) => { await flush({ step: to }); setStep(to); };
  const next = () => idx < steps.length - 1 && go(steps[idx + 1]);
  const prev = () => idx > 0 && go(steps[idx - 1]);
  const exit = async () => { await flush({ step }); router.push(`/campaigns/${draft?.channel ?? "email"}`); };
  const stepProblems = (s: Step) => problems.filter((p) => p.step === s);

  if (error) return <div className="wz"><div className="wz-body"><p className="text-bad p-8">{error} · <Link href="/campaigns/email">חזרה לקמפיינים</Link></p></div></div>;
  if (!draft) return <div className="wz"><div className="wz-body"><p className="p-8 text-muted">טוען…</p></div></div>;
  const locked = draft.campaignStatus && draft.campaignStatus !== "DRAFT";
  return (
    <div className="wz" data-testid="campaign-wizard" data-step={step}>
      <header className="wz-head">
        <div className="wz-brand"><span className="wz-mark">U</span><input className="wz-name" value={draft.name} onChange={(e) => patch({}, e.target.value)} aria-label="שם הקמפיין" data-testid="wz-name" /></div>
        <nav className="wz-steps" aria-label="שלבים">{steps.map((s, i) => { const done = i < idx; const bad = stepProblems(s).length > 0 && i !== idx; return <button key={s} className={`${s === step ? "active" : ""} ${bad ? "bad" : ""}`} onClick={() => go(s)} data-testid={`wz-step-${s}`}><span className="wz-num">{done ? <Check size={12} /> : i + 1}</span>{STEP_LABEL[s]}</button>; })}</nav>
        <div className="wz-actions">
          <span className={`wz-save ${saveState}`} data-testid="wz-save-state">{saveState === "saved" ? "נשמר" : saveState === "saving" ? "שומר…" : saveState === "dirty" ? "שינויים לא שמורים" : "שגיאת שמירה"}</span>
          <button className="wz-btn ghost" onClick={exit} data-testid="wz-exit">שמור וצא</button>
          {idx > 0 && <button className="wz-btn ghost" onClick={prev} data-testid="wz-prev">הקודם</button>}
          {step !== "review" && <button className="wz-btn primary" onClick={next} data-testid="wz-next">השלב הבא</button>}
        </div>
      </header>
      <div className="wz-body">
        {locked && <div className="wz-locked">הקמפיין כבר {draft.campaignStatus === "SCHEDULED" ? "מתוזמן" : "נשלח"} – התוכן מוצג לקריאה בלבד. <Link href={`/campaigns/report/${draft.campaignId}`}>לדוח</Link></div>}
        {step === "info" && <InfoStep draft={draft} patch={patch} problems={stepProblems("info")} />}
        {step === "audience" && <AudienceStep draft={draft} patch={patch} problems={stepProblems("audience")} />}
        {step === "template" && <TemplateStep draft={draft} patch={patch} problems={stepProblems("template")} />}
        {step === "content" && <ContentStep draft={draft} patch={patch} flush={flush} problems={stepProblems("content")} />}
        {step === "review" && <ReviewStep draft={draft} problems={problems} flush={flush} go={go} onSent={() => router.push(`/campaigns/${draft.channel}`)} />}
      </div>
    </div>
  );
}

// ───────────────────────── מידע ─────────────────────────
type Profile = { id: string; label: string; provider: string; simulated: boolean; sendingBlocked: boolean; status: string; senderName: string | null; senderEmail: string | null; replyTo: string | null; domainStatus: string | null; senders: Array<{ id?: string; value: string; type: string; inbound?: boolean }> | null; testRecipients: string[] | null; capabilities: Record<string, boolean> | null; unitPrice: number | null; currency: string | null };
type WaSender = { id: string; label: string; phone: string | null; isDefault: boolean; sendingBlocked: boolean };
function useSenders(channel: Channel) {
  const [data, setData] = useState<{ profiles?: Profile[]; senders?: WaSender[]; mock?: boolean } | null>(null);
  useEffect(() => { api<typeof data>(`/api/campaigns/senders?channel=${channel}`).then(setData).catch(() => setData({ profiles: [], senders: [] })); }, [channel]);
  return data;
}
function Field({ label, hint, children, error }: { label: string; hint?: string; children: React.ReactNode; error?: string }) { return <label className="wz-field"><span className="wz-label">{label}</span>{children}{error ? <span className="wz-err">{error}</span> : hint ? <span className="wz-hint">{hint}</span> : null}</label>; }
function ConnStatus({ p }: { p: Profile | null | undefined }) {
  if (!p) return <span className="wz-conn bad">אין חיבור פעיל · <Link href="/settings">הגדר חיבור</Link></span>;
  if (p.sendingBlocked) return <span className="wz-conn bad">החיבור חסום לשליחה ({p.status}) · <Link href="/settings">לחיבורים</Link></span>;
  if (p.simulated) return <span className="wz-conn warn">מצב הדמיה – לא נשלחות הודעות אמיתיות · <Link href="/settings">חבר ספק</Link></span>;
  return <span className="wz-conn ok">מחובר{p.domainStatus ? ` · דומיין ${p.domainStatus === "verified" ? "מאומת" : "לא מאומת"}` : ""}</span>;
}
function InfoStep({ draft, patch, problems }: { draft: Draft; patch: (d: Record<string, unknown>, name?: string) => void; problems: Problem[] }) {
  const senders = useSenders(draft.channel);
  const [more, setMore] = useState(false);
  const d = draft.data;
  const profile = senders?.profiles?.find((p) => p.id === d.senderCredentialId) ?? senders?.profiles?.[0] ?? null;
  useEffect(() => { if (senders?.profiles?.length && !d.senderCredentialId) patch({ senderCredentialId: senders.profiles[0].id, replyTo: d.replyTo ?? senders.profiles[0].replyTo ?? null }); if (draft.channel === "sms" && profile && !d.senderId && profile.senders?.length) patch({ senderId: profile.senders[0].value }); if (draft.channel === "whatsapp" && senders?.senders?.length && !d.senderCredentialId) patch({ senderCredentialId: (senders.senders.find((s) => s.isDefault) ?? senders.senders[0]).id }); }, [senders]); // eslint-disable-line react-hooks/exhaustive-deps
  const err = (s: string) => problems.find((p) => p.message.includes(s))?.message;
  return (
    <div className="wz-form" data-testid="wz-info">
      <Field label="שם הקמפיין" hint="לשימוש פנימי, אנשי הקשר שלכם לא יראו את שם הקמפיין" error={err("שם")}><input value={draft.name} onChange={(e) => patch({}, e.target.value)} data-testid="info-name" /></Field>
      {draft.channel === "email" && <>
        <Field label="שורת הנושא" hint="שורת נושא המייל שאנשי הקשר יראו בתיבת הדוא״ל" error={err("נושא")}><div className="wz-inline"><input value={d.subject ?? ""} onChange={(e) => patch({ subject: e.target.value })} data-testid="info-subject" /><TagPicker onPick={(t) => patch({ subject: `${d.subject ?? ""}{{${t}}}` })} /></div></Field>
        <Field label="תיאור קצר לפתיחה" hint="הכותרת המשנית תופיע לצד או מתחת לשורת הנושא (Preheader)"><input value={d.preheader ?? ""} onChange={(e) => patch({ preheader: e.target.value })} data-testid="info-preheader" /></Field>
        <Field label="מאת (פרופיל שליחה)" error={err("שולח")}><select value={d.senderCredentialId ?? ""} onChange={(e) => { const p = senders?.profiles?.find((x) => x.id === e.target.value); patch({ senderCredentialId: e.target.value || null, replyTo: p?.replyTo ?? null }); }} data-testid="info-sender">{!senders ? <option>טוען…</option> : !senders.profiles?.length ? <option value="">אין חיבור אימייל פעיל</option> : senders.profiles.map((p) => <option key={p.id} value={p.id}>{p.senderName ?? p.label} &lt;{p.senderEmail ?? "—"}&gt;{p.simulated ? " · הדמיה" : ""}</option>)}</select><ConnStatus p={senders ? profile : undefined} /></Field>
        <button type="button" className="wz-link" onClick={() => setMore((m) => !m)} data-testid="info-more">{more ? <ChevronUp size={14} /> : <ChevronDown size={14} />} אפשרויות נוספות</button>
        {more && <div className="wz-more">
          <Field label="כתובת לתשובות (Reply-To)" hint="ריק = כתובת השליחה של הפרופיל"><input dir="ltr" value={d.replyTo ?? ""} onChange={(e) => patch({ replyTo: e.target.value || null })} /></Field>
          <Field label="סוג ההודעה" hint="שיווקי: נשלח רק למי שנתן הסכמה, עם קישור הסרה ומגבלת תדירות"><select value={d.category ?? "MARKETING"} onChange={(e) => patch({ category: e.target.value })}><option value="MARKETING">שיווקי</option><option value="UTILITY">שירותי / תפעולי</option></select></Field>
          <div className="wz-track"><span className="wz-label">הגדרות מעקב</span><ul><li>{profile?.capabilities?.opens ? "✓ מעקב פתיחות פעיל (אות מהספק)" : "– הספק לא מדווח פתיחות"}</li><li>{profile?.capabilities?.clicks ? "✓ מעקב הקלקות פעיל" : "– הספק לא מדווח הקלקות"}</li><li>✓ קישור הסרה אישי לכל נמען</li></ul><span className="wz-hint">המעקב נקבע לפי החיבור (<Link href="/settings">הגדרות → חיבורים</Link>).</span></div>
        </div>}
      </>}
      {draft.channel === "sms" && <>
        <Field label="חיבור SMS" error={err("חיבור")}><select value={d.senderCredentialId ?? ""} onChange={(e) => patch({ senderCredentialId: e.target.value || null, senderId: null })} data-testid="info-sender">{!senders ? <option>טוען…</option> : !senders.profiles?.length ? <option value="">אין חיבור SMS פעיל</option> : senders.profiles.map((p) => <option key={p.id} value={p.id}>{p.label}{p.simulated ? " · הדמיה" : ""}</option>)}</select><ConnStatus p={senders ? profile : undefined} /></Field>
        <Field label="שולח מאושר" hint="מספר או שם שולח מתוך החיבור" error={err("שולח מאושר")}><select value={d.senderId ?? ""} onChange={(e) => patch({ senderId: e.target.value || null })} data-testid="info-sms-sender">{(profile?.senders ?? []).map((s) => <option key={s.value} value={s.value}>{s.value} ({s.type}{s.inbound ? ", דו-כיווני" : ""})</option>)}{!profile?.senders?.length && <option value="">אין שולחים מאושרים</option>}</select></Field>
        <Field label="סוג ההודעה"><select value={d.category ?? "MARKETING"} onChange={(e) => patch({ category: e.target.value })}><option value="MARKETING">שיווקי (עם הסרה)</option><option value="UTILITY">שירותי</option></select></Field>
      </>}
      {draft.channel === "whatsapp" && <>
        <Field label="מספר שולח (חשבון WhatsApp מחובר)"><select value={d.senderCredentialId ?? ""} onChange={(e) => patch({ senderCredentialId: e.target.value || null })} data-testid="info-sender">{!senders ? <option>טוען…</option> : senders.mock ? <option value="">מספר הדגמה (הדמיה)</option> : !senders.senders?.length ? <option value="">אין מספר מחובר</option> : senders.senders.map((s) => <option key={s.id} value={s.id}>{s.label}{s.phone ? ` · ${s.phone}` : ""}{s.sendingBlocked ? " · חסום" : ""}</option>)}</select>{senders?.mock && <span className="wz-conn warn">מצב הדמיה – לא נשלחות הודעות אמיתיות · <Link href="/settings/whatsapp">חבר WhatsApp</Link></span>}</Field>
      </>}
    </div>
  );
}
function TagPicker({ onPick }: { onPick: (tag: string) => void }) { return <select className="wz-tagpick" value="" onChange={(e) => e.target.value && onPick(e.target.value)} aria-label="הוסף משתנה"><option value="">{"{ } משתנה"}</option>{BUILTIN_TAGS.filter((t) => t !== "unsubscribe_url").map((t) => <option key={t} value={t}>{t}</option>)}</select>; }

// ───────────────────────── קהל יעד ─────────────────────────
type ListRow = { id: string; name: string; dynamic: boolean; count: number | null };
function AudienceStep({ draft, patch, problems }: { draft: Draft; patch: (d: Record<string, unknown>) => void; problems: Problem[] }) {
  const [lists, setLists] = useState<ListRow[] | null>(null);
  const [q, setQ] = useState(""); const [exOpen, setExOpen] = useState(false);
  const [preview, setPreview] = useState<{ eligible: number; remaining: number; matched: number; excluded: number; checkedAt: string } | null | "loading">(null);
  const sel = draft.data.listIds ?? []; const ex = draft.data.excludedListIds ?? [];
  useEffect(() => { api<{ lists: ListRow[] }>("/api/distribution-lists?counts=1").then((r) => setLists(r.lists)).catch(() => setLists([])); }, []);
  useEffect(() => {
    if (!sel.length) { setPreview(null); return; }
    setPreview("loading");
    const t = setTimeout(() => api<{ eligible: number; remaining: number; matched: number; excluded: number; checkedAt: string }>("/api/distribution-lists/preview", "POST", { listIds: sel, excludedListIds: ex, channel: draft.channel, marketing: (draft.data.category ?? "MARKETING") === "MARKETING" }).then(setPreview).catch(() => setPreview(null)), 300);
    return () => clearTimeout(t);
  }, [sel.join(","), ex.join(","), draft.channel, draft.data.category]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string) => patch({ listIds: sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id], excludedListIds: ex.filter((x) => x !== id) });
  const toggleEx = (id: string) => patch({ excludedListIds: ex.includes(id) ? ex.filter((x) => x !== id) : [...ex, id], listIds: sel.filter((x) => x !== id) });
  const visible = (lists ?? []).filter((l) => !q.trim() || l.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="wz-form wide" data-testid="wz-audience">
      <h2>בחירת קהלי יעד</h2>
      <p className="wz-sub">ניתן לבחור יותר מקהל אחד. איש קשר שנמצא בכמה קהלים יקבל הודעה אחת בלבד.</p>
      {problems.map((p) => <p key={p.message} className="wz-err">{p.message}</p>)}
      <label className="cmp-search wz-listsearch"><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש קהלים" aria-label="חיפוש קהלים" /></label>
      <div className="wz-lists" data-testid="audience-lists">
        {lists === null ? <p className="wz-hint">טוען קהלים…</p> : visible.length === 0 ? <p className="wz-hint">אין קהלים. <Link href="/audiences">צור קהל או ייבא אנשי קשר</Link></p> : visible.map((l) => (
          <label key={l.id} className={`wz-list ${sel.includes(l.id) ? "on" : ""}`} data-testid={`audience-${l.id}`}><input type="checkbox" checked={sel.includes(l.id)} onChange={() => toggle(l.id)} /><span className="wz-list-name">{l.name}{l.dynamic && <em>קהל דינמי</em>}</span><span className="wz-list-count">{l.count === null ? "—" : `${l.count.toLocaleString("he-IL")} אנשי קשר`}</span></label>
        ))}
      </div>
      <button type="button" className="wz-link" onClick={() => setExOpen((o) => !o)} data-testid="audience-exclude-toggle">{exOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />} החרגת קהלים{ex.length ? ` (${ex.length})` : ""}</button>
      {exOpen && <div className="wz-lists small">{(lists ?? []).filter((l) => !sel.includes(l.id)).map((l) => <label key={l.id} className={`wz-list ${ex.includes(l.id) ? "on ex" : ""}`}><input type="checkbox" checked={ex.includes(l.id)} onChange={() => toggleEx(l.id)} /><span className="wz-list-name">{l.name}</span><span className="wz-list-count">{l.count === null ? "—" : l.count.toLocaleString("he-IL")}</span></label>)}</div>}
      <div className="wz-total" data-testid="audience-total">
        {preview === "loading" ? <span>מחשב…</span> : preview ? <><strong>{preview.eligible.toLocaleString("he-IL")}</strong> נמענים ייחודיים זכאים לקבלת הודעה ב{CHANNEL_LABELS[draft.channel]}<span className="wz-hint">מתוך {preview.remaining.toLocaleString("he-IL")} בקהלים שנבחרו{preview.excluded ? ` (הוחרגו ${preview.excluded.toLocaleString("he-IL")})` : ""}. הזכאות (הסכמה, הסרות, חסימות, כתובת/מספר תקין, תדירות) מחושבת מחדש בזמן השליחה – הכמות עשויה להשתנות.</span></> : <span>סה״כ אנשי קשר: 0 – בחר קהל</span>}
      </div>
    </div>
  );
}

// ───────────────────────── תבנית ─────────────────────────
type EmailTpl = { id: string; name: string; subject: string | null; preheader: string | null; design: unknown; updatedAt?: string };
type WaTpl = { id: string; name: string; language: string; status: string; category: string; body: string; headerFormat: string | null; buttons: Array<{ type: string; text: string; url?: string; dynamic?: boolean }> | null };
function TemplateStep({ draft, patch, problems }: { draft: Draft; patch: (d: Record<string, unknown>) => void; problems: Problem[] }) {
  const [mine, setMine] = useState<EmailTpl[] | null>(null);
  const [wa, setWa] = useState<WaTpl[] | null>(null);
  const [q, setQ] = useState(""); const [tab, setTab] = useState<"mine" | "starters">("starters");
  const [preview, setPreview] = useState<{ name: string; html: string } | null>(null);
  useEffect(() => { if (draft.channel === "email") api<{ data: { items: EmailTpl[] } }>("/api/channels/email/templates").then((r) => setMine(r.data.items.filter((t) => t.design))).catch(() => setMine([])); else api<{ templates: WaTpl[] }>("/api/templates").then((r) => setWa(r.templates)).catch(() => setWa([])); }, [draft.channel]);
  useEffect(() => { if (draft.channel === "email" && mine && mine.length && draft.data.designSource === "blank") setTab("mine"); }, [mine]); // eslint-disable-line react-hooks/exhaustive-deps
  if (draft.channel === "whatsapp") {
    const list = (wa ?? []).filter((t) => !q.trim() || t.name.toLowerCase().includes(q.trim().toLowerCase()));
    return <div className="wz-form wide" data-testid="wz-template"><h2>תבנית WhatsApp</h2><p className="wz-sub">רק תבניות מאושרות מהחשבון המחובר ניתנות לשליחה (דרישת Meta).</p>{problems.map((p) => <p key={p.message} className="wz-err">{p.message}</p>)}
      <label className="cmp-search wz-listsearch"><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש תבנית" /></label>
      <div className="wz-lists">{wa === null ? <p className="wz-hint">טוען…</p> : list.length === 0 ? <p className="wz-hint">אין תבניות מאושרות. <Link href="/templates">לניהול תבניות וסנכרון</Link></p> : list.map((t) => <label key={t.id} className={`wz-list ${draft.data.templateId === t.id ? "on" : ""}`} data-testid={`template-${t.id}`}><input type="radio" name="tpl" checked={draft.data.templateId === t.id} onChange={() => patch({ templateId: t.id, variables: {}, mediaUrl: null, buttonParams: null })} /><span className="wz-list-name">{t.name}<em>{t.language} · {t.category} · {t.status === "APPROVED" ? "מאושרת" : t.status}</em><small>{t.body.slice(0, 140)}</small></span></label>)}</div></div>;
  }
  const pick = (design: EmailDesign, source: string) => { patch({ design: JSON.parse(JSON.stringify(design)), designSource: source }); toast.success("התבנית הועתקה לקמפיין – המקור לא ישתנה"); };
  const mineList = (mine ?? []).filter((t) => !q.trim() || t.name.toLowerCase().includes(q.trim().toLowerCase()));
  const starters = EMAIL_STARTERS.filter((s) => !q.trim() || s.name.includes(q.trim()));
  return (
    <div className="wz-form wide" data-testid="wz-template">
      <h2>בחירת תבנית</h2><p className="wz-sub">הקמפיין מקבל עותק של התבנית; עריכה כאן לא משנה את התבנית המקורית.</p>
      {problems.map((p) => <p key={p.message} className="wz-err">{p.message}</p>)}
      <div className="wz-gallery-head"><div className="wz-seg"><button className={tab === "mine" ? "active" : ""} onClick={() => setTab("mine")} data-testid="gallery-mine">התבניות שלי ({mine?.length ?? 0})</button><button className={tab === "starters" ? "active" : ""} onClick={() => setTab("starters")} data-testid="gallery-starters">תבניות מוכנות</button></div><label className="cmp-search"><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש" /></label></div>
      <div className="wz-gallery">
        <article className={`wz-card blank ${draft.data.designSource === "blank" ? "on" : ""}`}><div className="wz-card-preview"><span>+</span></div><h4>התחלה מתבנית ריקה</h4><button className="wz-btn small" onClick={() => pick(emailDesignSchema.parse({ blocks: [{ type: "heading", text: "כותרת" }, { type: "text", text: "הטקסט שלך כאן" }, { type: "footer", text: "" }] }), "blank")} data-testid="gallery-blank">בחר</button></article>
        {(tab === "mine" ? mineList.map((t) => ({ key: t.id, name: t.name, desc: t.subject ?? "", design: emailDesignSchema.safeParse(t.design).data ?? null })) : starters.map((s) => ({ key: `starter:${s.key}`, name: s.name, desc: s.description, design: emailDesignSchema.safeParse(s.design).data ?? null }))).map((c) => c.design ? (
          <article key={c.key} className={`wz-card ${draft.data.designSource === c.key ? "on" : ""}`} data-testid={`gallery-${c.key}`}>
            <div className="wz-card-preview"><iframe title={c.name} srcDoc={renderEmailHtml(c.design)} sandbox="" tabIndex={-1} /></div>
            <h4>{c.name}</h4><p>{c.desc}</p>
            <div className="wz-card-actions"><button className="wz-btn small ghost" onClick={() => setPreview({ name: c.name, html: renderEmailHtml(c.design!) })}>תצוגה מקדימה</button><button className="wz-btn small" onClick={() => pick(c.design!, c.key)}>{draft.data.designSource === c.key ? "נבחר ✓" : "בחר"}</button></div>
          </article>) : null)}
        {tab === "mine" && mine && mine.length === 0 && <p className="wz-hint">אין תבניות אימייל שמורות. <Link href="/templates">ניהול תבניות</Link></p>}
      </div>
      {preview && <div className="wz-modal" role="dialog" aria-label={preview.name}><div className="wz-modal-box"><header><strong>{preview.name}</strong><button onClick={() => setPreview(null)} aria-label="סגור"><X size={18} /></button></header><iframe title="preview" srcDoc={preview.html} sandbox="" /></div></div>}
    </div>
  );
}

// ───────────────────────── תוכן ─────────────────────────
function ContentStep({ draft, patch, flush, problems }: { draft: Draft; patch: (d: Record<string, unknown>) => void; flush: () => Promise<void>; problems: Problem[] }) {
  const [testTo, setTestTo] = useState(draft.data.testTo ?? "");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const senders = useSenders(draft.channel);
  const profile = senders?.profiles?.find((p) => p.id === draft.data.senderCredentialId) ?? senders?.profiles?.[0] ?? null;
  const sendTest = async () => { setBusy(true); try { await flush(); const r = await api<{ data?: { simulated?: boolean } }>(`/api/campaigns/drafts/${draft.id}/test`, "POST", { to: testTo }); toast.success(`${r.data?.simulated ? "הדמיה: " : ""}הודעת בדיקה נשלחה ל-${testTo}`); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } };
  const testBar = <div className="wz-testbar"><input dir="ltr" placeholder={draft.channel === "email" ? "נמען בדיקה (מוגדר בחיבור)" : "מספר בדיקה מורשה"} value={testTo} onChange={(e) => setTestTo(e.target.value)} aria-label="נמען בדיקה" data-testid="content-test-to" list="test-recipients" /><datalist id="test-recipients">{(profile?.testRecipients ?? []).map((t) => <option key={t} value={t} />)}</datalist><button className="wz-btn ghost" disabled={busy || !testTo} onClick={sendTest} data-testid="content-test-send">שליחת ניסיון</button><button className="wz-btn ghost" onClick={() => setPreview((p) => !p)}>{preview ? "סגור תצוגה" : "תצוגה מקדימה"}</button></div>;
  if (draft.channel === "email") {
    const parsed = emailDesignSchema.safeParse(draft.data.design);
    const design = parsed.success ? parsed.data : emailDesignSchema.parse({ blocks: [{ type: "text", text: "הטקסט שלך" }] });
    return <div className="wz-content" data-testid="wz-content">{problems.map((p) => <p key={p.message} className="wz-err">{p.message}</p>)}{testBar}
      {preview ? <div className="wz-preview"><iframe title="תצוגה מקדימה" srcDoc={renderEmailHtml(design, { preheader: draft.data.preheader })} sandbox="" /></div> : <EmailEditor design={design} preheader={draft.data.preheader} onChange={(d) => patch({ design: d })} />}
    </div>;
  }
  if (draft.channel === "sms") return <SmsContent draft={draft} patch={patch} problems={problems} testBar={testBar} unitPrice={profile?.unitPrice ?? null} currency={profile?.currency ?? null} />;
  return <WhatsAppContent draft={draft} patch={patch} problems={problems} testBar={testBar} />;
}
function SmsContent({ draft, patch, problems, testBar, unitPrice, currency }: { draft: Draft; patch: (d: Record<string, unknown>) => void; problems: Problem[]; testBar: React.ReactNode; unitPrice: number | null; currency: string | null }) {
    const body = draft.data.body ?? "";
    const footer = (draft.data.category ?? "MARKETING") === "MARKETING" ? "\nלהסרה השיבו הסר" : "";
    const m = smsMetrics(body + footer);
    const extra = mergeTagsOf(body).filter((t) => !BUILTIN_TAGS.includes(t.tag) && !t.tag.startsWith("custom."));
    const ta = useRef<HTMLTextAreaElement>(null);
    const insert = (tag: string) => { const el = ta.current; const s = el?.selectionStart ?? body.length; const v = `${body.slice(0, s)}{{${tag}}}${body.slice(s)}`; patch({ body: v }); };
    return <div className="wz-content sms" data-testid="wz-content">{problems.map((p) => <p key={p.message} className="wz-err">{p.message}</p>)}{testBar}
      <div className="wz-sms">
        <div className="wz-sms-edit"><label className="wz-field"><span className="wz-label">תוכן ההודעה</span><textarea ref={ta} rows={8} value={body} onChange={(e) => patch({ body: e.target.value })} data-testid="sms-body" /></label>
          <div className="wz-tags">{BUILTIN_TAGS.filter((t) => t !== "unsubscribe_url" && t !== "email").map((t) => <button key={t} type="button" onClick={() => insert(`${t}|`)}>{`{{${t}}}`}</button>)}</div>
          <p className="wz-hint" data-testid="sms-metrics">קידוד {m.encoding} · {m.length} תווים · <b>{m.segments}</b> מקטעים לנמען{footer ? " (כולל שורת הסרה)" : ""}{unitPrice != null ? ` · אומדן ${(m.segments * unitPrice).toFixed(3)} ${currency ?? ""} לנמען (מחיר יחידה ידני)` : " · עלות: לא מחובר תמחור"}</p>
          {extra.length > 0 && <div className="wz-more"><span className="wz-label">ערכים למשתנים מותאמים</span>{extra.map((t) => <label key={t.tag} className="wz-field"><span className="wz-label">{`{{${t.tag}}}`}{t.fallback !== null ? ` (ברירת מחדל: ${t.fallback})` : ""}</span><input value={draft.data.variables?.[t.tag] ?? ""} onChange={(e) => patch({ variables: { ...(draft.data.variables ?? {}), [t.tag]: e.target.value } })} /></label>)}</div>}
        </div>
        <div className="wz-phone" aria-label="תצוגת טלפון"><div className="wz-phone-screen"><div className="wz-bubble">{(body || "ההודעה שלך תוצג כאן").replace(/\{\{(\w+)\|?([^}]*)\}\}/g, (_, t, f) => f || (t === "first_name" ? "ישראל" : t === "name" ? "ישראל ישראלי" : `[${t}]`))}{footer}</div></div></div>
      </div>
    </div>;
  }
function WhatsAppContent({ draft, patch, problems, testBar }: { draft: Draft; patch: (d: Record<string, unknown>) => void; problems: Problem[]; testBar: React.ReactNode }) {
  const [tpl, setTpl] = useState<WaTpl | null>(null);
  useEffect(() => { api<{ templates: WaTpl[] }>("/api/templates").then((r) => setTpl(r.templates.find((t) => t.id === draft.data.templateId) ?? null)).catch(() => undefined); }, [draft.data.templateId]);
  if (!tpl) return <div className="wz-content" data-testid="wz-content"><p className="wz-hint">{draft.data.templateId ? "טוען תבנית…" : "בחר תבנית בשלב הקודם."}</p></div>;
  const keys = templateParameterKeys(tpl.body); const vars = draft.data.variables ?? {};
  const header = (tpl.headerFormat ?? "").toUpperCase(); const needsMedia = ["IMAGE", "VIDEO", "DOCUMENT"].includes(header);
  const dyn = (tpl.buttons ?? []).map((b, i) => ({ ...b, index: i })).filter((b) => b.type === "URL" && b.dynamic);
  return <div className="wz-content" data-testid="wz-content">{problems.map((p) => <p key={p.message} className="wz-err">{p.message}</p>)}{testBar}
    <div className="wz-sms">
      <div className="wz-sms-edit">
        {keys.map((k) => <label key={k} className="wz-field"><span className="wz-label">משתנה {`{{${k}}}`}</span><input value={vars[k] ?? ""} onChange={(e) => patch({ variables: { ...vars, [k]: e.target.value } })} placeholder="ערך קבוע, או {name} לשם הלקוח" data-testid={`wa-var-${k}`} /></label>)}
        {needsMedia && <label className="wz-field"><span className="wz-label">מדיה לכותרת ({header === "IMAGE" ? "תמונה" : header === "VIDEO" ? "וידאו" : "מסמך"}) – קישור https ציבורי</span><input dir="ltr" value={draft.data.mediaUrl ?? ""} onChange={(e) => patch({ mediaUrl: e.target.value || null })} /></label>}
        {dyn.map((b) => <label key={b.index} className="wz-field"><span className="wz-label">כפתור &quot;{b.text}&quot; – סיומת הקישור ({b.url})</span><input dir="ltr" value={draft.data.buttonParams?.[String(b.index)] ?? ""} onChange={(e) => patch({ buttonParams: { ...(draft.data.buttonParams ?? {}), [String(b.index)]: e.target.value } })} /></label>)}
        {!keys.length && !needsMedia && !dyn.length && <p className="wz-hint">לתבנית זו אין משתנים – אפשר להמשיך לבקרה.</p>}
      </div>
      <div className="wz-phone wa" aria-label="תצוגת הודעה"><div className="wz-phone-screen">{needsMedia && <div className="wz-media">{draft.data.mediaUrl ? (header === "IMAGE" ? <img src={draft.data.mediaUrl} alt="" /> : <span>{header}</span>) : <span>מדיה</span>}</div>}<div className="wz-bubble">{renderTemplate(tpl.body, Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, v.replaceAll("{name}", "ישראל")])))}</div>{(tpl.buttons ?? []).map((b, i) => <div key={i} className="wz-wa-btn">{b.text}</div>)}</div></div>
    </div>
  </div>;
}

// ───────────────────────── בקרה ─────────────────────────
type Preflight = { eligible: number; totalQueued: number; audienceExcluded: number; exclusions: Record<string, number>; blockers: string[]; samples: Array<{ name: string; body: string; subject?: string; phone: string }>; sender: string; simulated: boolean; cost: { total: number | null; currency: string | null; known: boolean; units: number } | null; timezone?: string; sendWindow?: { start: string; end: string; maxPerMinute?: number } | null };
function ReviewStep({ draft, problems, flush, go, onSent }: { draft: Draft; problems: Problem[]; flush: () => Promise<void>; go: (s: Step) => Promise<void>; onSent: () => void }) {
  const [state, setState] = useState<{ campaignId: string; preflight: Preflight } | null>(null);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [when, setWhen] = useState("");
  const [confirm, setConfirm] = useState<"now" | "schedule" | null>(null);
  const [sending, setSending] = useState(false);
  const [testTo, setTestTo] = useState(draft.data.testTo ?? "");
  const senders = useSenders(draft.channel);
  const profile = senders?.profiles?.find((p) => p.id === draft.data.senderCredentialId) ?? senders?.profiles?.[0] ?? null;
  const built = useRef(false);
  const build = useCallback(async () => {
    setBuilding(true); setError(null);
    try { await flush(); const r = await api<{ campaignId: string; preflight: Preflight }>(`/api/campaigns/drafts/${draft.id}/build`, "POST"); setState(r); }
    catch (e) { setError((e as Error).message); }
    finally { setBuilding(false); }
  }, [draft.id, flush]);
  useEffect(() => { if (!built.current && problems.length === 0) { built.current = true; void build(); } }, [problems.length, build]);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const send = async () => {
    if (!state || sending) return; setSending(true);
    try {
      const scheduledAt = confirm === "schedule" && when ? new Date(when).toISOString() : undefined;
      await api(`/api/campaigns/${state.campaignId}`, "PATCH", { action: "start", scheduledAt, scheduledTimezone: scheduledAt ? tz : undefined });
      toast.success(scheduledAt ? "הקמפיין תוזמן" : "הקמפיין יצא לשליחה"); onSent();
    } catch (e) { toast.error((e as Error).message); setSending(false); setConfirm(null); }
  };
  const sendTest = async () => { try { const r = await api<{ data?: { simulated?: boolean } }>(`/api/campaigns/drafts/${draft.id}/test`, "POST", { to: testTo }); toast.success(`${r.data?.simulated ? "הדמיה: " : ""}הודעת בדיקה נשלחה`); } catch (e) { toast.error((e as Error).message); } };
  const pf = state?.preflight;
  const rows: Array<{ label: string; ok: boolean | null; detail: string; step: Step }> = [
    { label: "שולח וחיבור", ok: pf ? !pf.blockers.some((b) => b.includes("חיבור") || b.includes("דומיין")) : problems.some((p) => p.step === "info") ? false : null, detail: pf?.sender ?? (problems.find((p) => p.step === "info")?.message ?? "ייבדק אחרי בניית הקמפיין"), step: "info" },
    { label: "קהל יעד", ok: pf ? pf.eligible > 0 : problems.some((p) => p.step === "audience") ? false : null, detail: pf ? `${pf.eligible.toLocaleString("he-IL")} נמענים זכאים מתוך ${pf.totalQueued.toLocaleString("he-IL")}${Object.keys(pf.exclusions).length ? " · לא זכאים: " + Object.entries(pf.exclusions).map(([k, v]) => `${k} (${v})`).join(", ") : ""}` : (problems.find((p) => p.step === "audience")?.message ?? "—"), step: "audience" },
    { label: draft.channel === "whatsapp" ? "תבנית מאושרת" : "תוכן ותבנית", ok: pf ? !pf.blockers.some((b) => b.includes("תבנית")) : problems.some((p) => p.step === "content" || p.step === "template") ? false : null, detail: pf ? (pf.blockers.find((b) => b.includes("תבנית")) ?? "התוכן תקין ונשמר כעותק לקמפיין") : (problems.find((p) => p.step === "content" || p.step === "template")?.message ?? "—"), step: draft.channel === "whatsapp" ? "template" : "content" },
    { label: "משתנים אישיים וערכי גיבוי", ok: pf ? !(pf.exclusions["משתנים חסרים"]) : null, detail: pf ? (pf.exclusions["משתנים חסרים"] ? `${pf.exclusions["משתנים חסרים"]} נמענים עם משתנים חסרים ללא ברירת מחדל – הוסף ברירת מחדל ({{first_name|לקוח}})` : "לכל המשתנים יש ערך או ברירת מחדל") : "—", step: "content" },
    { label: "קישורים ומנגנון הסרה", ok: true, detail: draft.channel === "email" ? "קישור הסרה אישי מתווסף לכל מייל" : draft.channel === "sms" ? ((draft.data.category ?? "MARKETING") === "MARKETING" ? "שורת 'להסרה השיבו הסר' מתווספת" : "הודעה שירותית – ללא שורת הסרה") : "תשובת 'הסר' מסירה מדיוור אוטומטית", step: "content" },
    ...(draft.channel === "email" ? [{ label: "הגדרות מעקב", ok: true as boolean | null, detail: `${profile?.capabilities?.opens ? "פתיחות ✓" : "פתיחות –"} · ${profile?.capabilities?.clicks ? "הקלקות ✓" : "הקלקות –"} (לפי הספק)`, step: "info" as Step }] : []),
    { label: "מועד שליחה ואזור זמן", ok: true, detail: when ? `מתוזמן ל-${new Date(when).toLocaleString("he-IL")} (${pf?.timezone ?? tz})` : `שליחה מיידית (${pf?.timezone ?? tz})${pf?.sendWindow ? ` · חלון שליחה ${pf.sendWindow.start}–${pf.sendWindow.end}` : ""}`, step: "review" },
  ];
  const blockers = [...(pf?.blockers ?? []), ...problems.map((p) => p.message), ...(error ? [error] : [])];
  const canSend = Boolean(state) && blockers.length === 0 && (pf?.eligible ?? 0) > 0 && !sending;
  return (
    <div className="wz-form wide" data-testid="wz-review">
      <h2>הקמפיין מוכן לשליחה?</h2><p className="wz-sub">יש לוודא שכל ההגדרות נכונות לפני שליחת הקמפיין. מומלץ לבצע &quot;שליחת ניסיון&quot; טרם השליחה האמיתית.</p>
      {pf?.simulated && <div className="wz-sim">מצב הדמיה: הספק מדומה – לא יישלחו הודעות אמיתיות.</div>}
      {building && <p className="wz-hint">בונה את הקמפיין ובודק את הקהל…</p>}
      {error && <p className="wz-err">{error} <button className="wz-link" onClick={build}>נסה שוב</button></p>}
      <ul className="wz-checks" data-testid="review-checks">{rows.map((r) => <li key={r.label} className={r.ok === false ? "bad" : r.ok ? "ok" : ""}><span className="wz-check-icon">{r.ok === false ? "✕" : r.ok ? "✓" : "…"}</span><div><strong>{r.label}</strong><p>{r.detail}</p></div>{r.step !== "review" && <button className="wz-btn small ghost" onClick={() => go(r.step)}>עריכה</button>}</li>)}</ul>
      {pf && pf.samples.length > 0 && <details className="wz-samples"><summary>דוגמאות להודעה כפי שתתקבל ({pf.samples.length})</summary>{pf.samples.map((s, i) => <div key={i} className="wz-sample"><strong>{s.name}</strong> <span dir="ltr">{s.phone}</span>{s.subject && <p><b>נושא:</b> {s.subject}</p>}<pre>{s.body}</pre></div>)}</details>}
      <div className="wz-total"><strong>{(pf?.eligible ?? 0).toLocaleString("he-IL")}</strong> נמענים ישלחו{pf?.cost?.known && pf.cost.total !== null ? <span className="wz-hint"> · אומדן עלות {pf.cost.total} {pf.cost.currency ?? ""} (לפי מחיר יחידה ידני)</span> : null}</div>
      <div className="wz-testbar"><input dir="ltr" placeholder={draft.channel === "whatsapp" ? "מספר בדיקה מורשה" : "נמען בדיקה (מוגדר בחיבור)"} value={testTo} onChange={(e) => setTestTo(e.target.value)} aria-label="נמען בדיקה" data-testid="review-test-to" /><button className="wz-btn ghost" disabled={!testTo || !state} onClick={sendTest} data-testid="review-test-send">שליחת ניסיון</button></div>
      <div className="wz-sendbar">
        <label className="wz-field inline"><span className="wz-label">תזמון (אופציונלי)</span><input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} data-testid="review-when" /></label>
        <button className="wz-btn ghost" disabled={!canSend || !when} onClick={() => setConfirm("schedule")} data-testid="review-schedule">תזמון</button>
        <button className="wz-btn primary big" disabled={!canSend} onClick={() => setConfirm("now")} data-testid="review-send-now">שליחה עכשיו</button>
      </div>
      {blockers.length > 0 && <ul className="wz-blockers">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
      {confirm && state && <div className="wz-modal" role="dialog" aria-label="אישור שליחה"><div className="wz-modal-box small"><header><strong>{confirm === "now" ? "לשלוח עכשיו?" : "לתזמן את הקמפיין?"}</strong><button onClick={() => !sending && setConfirm(null)} aria-label="סגור"><X size={18} /></button></header>
        <dl className="wz-confirm"><dt>ערוץ</dt><dd>{CHANNEL_LABELS[draft.channel]}</dd><dt>קמפיין</dt><dd>{draft.name}</dd><dt>קהל</dt><dd>{pf?.eligible.toLocaleString("he-IL")} נמענים זכאים</dd><dt>מועד</dt><dd>{confirm === "schedule" ? new Date(when).toLocaleString("he-IL") : "מיידי"} ({tz})</dd>{pf?.simulated && <><dt>מצב</dt><dd>הדמיה – ללא שליחה אמיתית</dd></>}</dl>
        <p className="wz-hint">הזכאות (הסכמה, הסרות, חסימות, תדירות) נבדקת שוב לכל נמען בזמן השליחה.</p>
        <div className="wz-modal-actions"><button className="wz-btn ghost" disabled={sending} onClick={() => setConfirm(null)}>ביטול</button><button className="wz-btn primary" disabled={sending} onClick={send} data-testid="review-confirm">{sending ? "שולח…" : confirm === "now" ? "אשר ושלח" : "אשר ותזמן"}</button></div></div></div>}
    </div>
  );
}
