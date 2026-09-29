"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { CHANNEL_LABELS, templateParameterKeys, renderTemplate, throttleLabel, type Throttle } from "@/lib/campaigns";
import { emailDesignSchema, renderEmailHtml, type EmailDesign } from "@/lib/email/blocks";
import { EMAIL_STARTERS } from "@/lib/email/starters";
import { smsMetrics } from "@/lib/sms";
import { mergeTagsOf } from "@/lib/merge-tags";
import { EmailEditor } from "./email-editor";
import { PaceEditor, type MetaLimit } from "./pace-editor";
import { useT } from "@/components/i18n/LangProvider";
import { parseLang, pick } from "@/lib/i18n";

type Channel = "whatsapp" | "sms" | "email";
type Step = "info" | "audience" | "template" | "content" | "review";
interface Draft { id: string; channel: Channel; name: string; step: string; data: Record<string, unknown> & { subject?: string; preheader?: string; senderCredentialId?: string | null; senderId?: string | null; replyTo?: string | null; listIds?: string[]; excludedListIds?: string[]; templateId?: string | null; designSource?: string | null; design?: unknown; body?: string; variables?: Record<string, string>; mediaUrl?: string | null; buttonParams?: Record<string, string> | null; category?: "MARKETING" | "UTILITY"; scheduledAt?: string | null; testTo?: string }; templateId: string | null; campaignId: string | null; campaignStatus: string | null; steps: Step[] }
type Problem = { step: string; message: string };
const STEP_LABEL: Record<Step, { he: string; en: string }> = { info: { he: "מידע", en: "Info" }, audience: { he: "קהל יעד", en: "Audience" }, template: { he: "תבנית", en: "Template" }, content: { he: "תוכן", en: "Content" }, review: { he: "בקרה", en: "Review" } };
const BUILTIN_TAGS = ["name", "first_name", "company", "city", "email", "phone", "unsubscribe_url"];

/** Key-order independent JSON (the server may return the draft's keys in another order). */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

async function api<T = unknown>(url: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof d.error === "string" ? d.error : pick(parseLang(document.cookie.match(/(?:^|; )lang=([^;]*)/)?.[1]), "הפעולה נכשלה", "Action failed"));
  return d as T;
}

/** Full-screen campaign builder. Every change autosaves (debounced); steps validate lazily so the user can move around freely. */
export function CampaignWizard({ draftId }: { draftId: string }) {
  const t = useT();
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [step, setStep] = useState<Step>("info");
  const [saveState, setSaveState] = useState<"saved" | "saving" | "dirty" | "error">("saved");
  const pending = useRef<{ name?: string; data?: Record<string, unknown> }>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "צא בלי לשמור": the draft as it was when the editor opened (autosave writes every edit, so this is what we go back
  // to). A draft created by "יצירת קמפיין" (?new=1) is deleted instead.
  const isNew = useSearchParams().get("new") === "1";
  const [snapshot, setSnapshot] = useState<{ name: string; step: string; data: Record<string, unknown>; templateId: string | null; campaignId: string | null } | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);

  useEffect(() => { api<{ draft: Draft; problems: Problem[] }>(`/api/campaigns/drafts/${draftId}`).then((r) => { setDraft(r.draft); setProblems(r.problems); setStep((r.draft.step as Step) || "info"); setSnapshot((s) => s ?? { name: r.draft.name, step: r.draft.step, data: r.draft.data, templateId: (r.draft as Draft & { templateId?: string | null }).templateId ?? null, campaignId: (r.draft as Draft & { campaignId?: string | null }).campaignId ?? null }); }).catch((e) => setError(e.message)); }, [draftId]);

  const chain = useRef<Promise<void>>(Promise.resolve());
  const flush = useCallback((extra?: { step?: Step }) => {
    // Saves run strictly one after another; a response is laid under any edits made while it was in flight.
    const job = chain.current.then(async () => {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      const body = { ...pending.current, ...(extra ?? {}) }; pending.current = {};
      if (!body.name && !body.data && !body.step) return;
      setSaveState("saving");
      try {
        const r = await api<{ draft: Draft; problems: Problem[] }>(`/api/campaigns/drafts/${draftId}`, "PATCH", body);
        const newer = pending.current;
        setDraft((d) => ({ ...r.draft, name: newer.name ?? r.draft.name, step: d?.step ?? r.draft.step, data: { ...r.draft.data, ...(newer.data ?? {}) } }));
        setProblems(r.problems); setSaveState(newer.data || newer.name ? "dirty" : "saved");
      } catch (e) { setSaveState("error"); toast.error((e as Error).message); }
    });
    chain.current = job.catch(() => undefined);
    return job;
  }, [draftId]);
  const lockedRef = useRef(false);
  const patch = useCallback((data: Record<string, unknown>, name?: string, opts?: { auto?: boolean }) => {
    if (lockedRef.current) return;
    // Defaults the builder fills in by itself (e.g. the only sender) are not the user's changes: they join the
    // "opened" state, so leaving an untouched draft does not ask, and discarding keeps them.
    if (opts?.auto) setSnapshot((s) => s ? { ...s, data: { ...s.data, ...data } } : s);
    setDraft((d) => d ? { ...d, ...(name !== undefined ? { name } : {}), data: { ...d.data, ...data } } : d);
    pending.current = { ...pending.current, data: { ...(pending.current.data ?? {}), ...data }, ...(name !== undefined ? { name } : {}) };
    setSaveState("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, 700);
  }, [flush]);
  // Leaving the page (tab close, link, back) must not drop the last debounced edits.
  useEffect(() => {
    const save = () => {
      const body = pending.current; if (!body.name && !body.data) return; pending.current = {};
      try { void fetch(`/api/campaigns/drafts/${draftId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: true }); } catch { /* best effort */ }
    };
    const onHide = () => save();
    window.addEventListener("pagehide", onHide);
    return () => { window.removeEventListener("pagehide", onHide); if (timer.current) clearTimeout(timer.current); save(); };
  }, [draftId]);
  useEffect(() => { const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") return; }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, []);

  useEffect(() => { lockedRef.current = Boolean(draft?.campaignStatus && draft.campaignStatus !== "DRAFT"); }, [draft?.campaignStatus]);
  const steps = draft?.steps ?? [];
  const idx = steps.indexOf(step);
  const go = async (to: Step) => { await flush({ step: to }); setStep(to); };
  const next = () => idx < steps.length - 1 && go(steps[idx + 1]);
  const prev = () => idx > 0 && go(steps[idx - 1]);
  const exit = async () => { await flush({ step }); router.push(`/campaigns/${draft?.channel ?? "email"}`); };
  const hasChanges = Boolean(draft && snapshot && stable({ name: draft.name, data: draft.data }) !== stable({ name: snapshot.name, data: snapshot.data }));
  /** Leaving (exit button / logo): with changes → ask; without → go (a brand-new untouched draft is not kept). */
  const leaveTo = async (dest: string) => {
    if (draft?.campaignStatus && draft.campaignStatus !== "DRAFT") { router.push(dest); return; }
    if (hasChanges) { setLeaving(dest); return; }
    if (isNew) { await discard(dest); return; }
    await flush({ step }); router.push(dest);
  };
  const discard = async (dest: string) => {
    setDiscarding(true);
    try {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      pending.current = {};
      await chain.current; // let an in-flight save land first, then undo it
      if (isNew) await api(`/api/campaigns/drafts/${draftId}`, "DELETE");
      else if (snapshot) await api(`/api/campaigns/drafts/${draftId}/revert`, "POST", snapshot);
      router.push(dest);
    } catch (e) { toast.error((e as Error).message); setDiscarding(false); }
  };
  const stepProblems = (s: Step) => problems.filter((p) => p.step === s);

  if (error) return <div className="wz"><div className="wz-body"><p className="text-bad p-8">{error} · <Link href="/campaigns/email">{t("חזרה לקמפיינים", "Back to campaigns")}</Link></p></div></div>;
  if (!draft) return <div className="wz"><div className="wz-body"><p className="p-8 text-muted">{t("טוען…", "Loading…")}</p></div></div>;
  const locked = Boolean(draft.campaignStatus && draft.campaignStatus !== "DRAFT");
  return (
    <div className="wz" data-testid="campaign-wizard" data-step={step}>
      <header className="wz-head">
        <div className="wz-brand"><button type="button" className="wz-mark" onClick={() => void leaveTo("/")} aria-label={t("למסך הבית", "Home")} title={t("למסך הבית", "Home")} data-testid="wz-home">U</button><input className="wz-name" value={draft.name} onChange={(e) => patch({}, e.target.value)} aria-label={t("שם הקמפיין", "Campaign name")} data-testid="wz-name" /></div>
        <nav className="wz-steps" aria-label={t("שלבים", "Steps")}>{steps.map((s, i) => { const done = i < idx; const bad = stepProblems(s).length > 0 && i !== idx; return <button key={s} className={`${s === step ? "active" : ""} ${bad ? "bad" : ""}`} onClick={() => go(s)} data-testid={`wz-step-${s}`}><span className="wz-num">{done ? <Check size={12} /> : i + 1}</span>{t(STEP_LABEL[s].he, STEP_LABEL[s].en)}</button>; })}</nav>
        <div className="wz-actions">
          <span className={`wz-save ${saveState}`} data-testid="wz-save-state">{saveState === "saved" ? t("נשמר", "Saved") : saveState === "saving" ? t("שומר…", "Saving…") : saveState === "dirty" ? t("שינויים לא שמורים", "Unsaved changes") : t("שגיאת שמירה", "Save error")}</span>
          <button className="wz-btn ghost" onClick={() => void leaveTo(`/campaigns/${draft.channel}`)} data-testid="wz-leave">{t("יציאה", "Exit")}</button>
          <button className="wz-btn ghost" onClick={exit} data-testid="wz-exit">{t("שמור וצא", "Save & exit")}</button>
          {idx > 0 && <button className="wz-btn ghost" onClick={prev} data-testid="wz-prev">{t("הקודם", "Back")}</button>}
          {step !== "review" && <button className="wz-btn primary" onClick={next} data-testid="wz-next">{t("השלב הבא", "Next step")}</button>}
        </div>
      </header>
      {leaving && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="wz-leave-title" data-testid="wz-leave-dialog">
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <h2 id="wz-leave-title" className="text-base font-semibold">{t("יש שינויים שלא נשמרו בקמפיין", "This campaign has unsaved changes")}</h2>
            <p className="mt-2 text-sm text-muted">{isNew ? t("יציאה בלי לשמור תמחק את הטיוטה שנוצרה.", "Leaving without saving deletes the draft that was created.") : t("יציאה בלי לשמור תחזיר את הטיוטה למצב שבו פתחת אותה.", "Leaving without saving puts the draft back as it was when you opened it.")}</p>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button className="wz-btn ghost" onClick={() => setLeaving(null)} disabled={discarding} data-testid="wz-keep-editing">{t("המשך עריכה", "Keep editing")}</button>
              <button className="wz-btn ghost" onClick={() => void discard(leaving)} disabled={discarding} data-testid="wz-discard">{discarding ? t("מבטל…", "Discarding…") : t("צא בלי לשמור", "Leave without saving")}</button>
              <button className="wz-btn primary" onClick={async () => { const d = leaving; setLeaving(null); await flush({ step }); router.push(d); }} disabled={discarding} data-testid="wz-save-leave">{t("שמור וצא", "Save & exit")}</button>
            </div>
          </div>
        </div>
      )}
      <div className="wz-body">
        {locked && <div className="wz-locked">{draft.campaignStatus === "SCHEDULED" ? t("הקמפיין כבר מתוזמן – התוכן מוצג לקריאה בלבד.", "The campaign is already scheduled – content is read-only.") : t("הקמפיין כבר נשלח – התוכן מוצג לקריאה בלבד.", "The campaign has already been sent – content is read-only.")} <Link href={`/campaigns/report/${draft.campaignId}`}>{t("לדוח", "View report")}</Link></div>}
        <fieldset className="wz-fieldset" disabled={locked}>
        {step === "info" && <InfoStep draft={draft} patch={patch} problems={stepProblems("info")} />}
        {step === "audience" && <AudienceStep draft={draft} patch={patch} problems={stepProblems("audience")} />}
        {step === "template" && <TemplateStep draft={draft} patch={patch} problems={stepProblems("template")} />}
        {step === "content" && <ContentStep draft={draft} patch={patch} flush={flush} problems={stepProblems("content")} />}
        {step === "review" && !locked && <ReviewStep draft={draft} patch={patch} problems={problems} flush={flush} go={go} onSent={() => router.push(`/campaigns/${draft.channel}`)} />}
        </fieldset>
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
  const t = useT();
  if (!p) return <span className="wz-conn bad">{t("אין חיבור פעיל", "No active connection")} · <Link href="/settings">{t("הגדר חיבור", "Set up a connection")}</Link></span>;
  if (p.sendingBlocked) return <span className="wz-conn bad">{t(`החיבור חסום לשליחה (${p.status})`, `Connection blocked for sending (${p.status})`)} · <Link href="/settings">{t("לחיבורים", "Connections")}</Link></span>;
  if (p.simulated) return <span className="wz-conn warn">{t("מצב הדמיה – לא נשלחות הודעות אמיתיות", "Simulation mode – no real messages are sent")} · <Link href="/settings">{t("חבר ספק", "Connect provider")}</Link></span>;
  return <span className="wz-conn ok">{t("מחובר", "Connected")}{p.domainStatus ? (p.domainStatus === "verified" ? t(" · דומיין מאומת", " · domain verified") : t(" · דומיין לא מאומת", " · domain not verified")) : ""}</span>;
}
function InfoStep({ draft, patch, problems }: { draft: Draft; patch: (d: Record<string, unknown>, name?: string, opts?: { auto?: boolean }) => void; problems: Problem[] }) {
  const t = useT();
  const senders = useSenders(draft.channel);
  const [more, setMore] = useState(false);
  const d = draft.data;
  const profile = senders?.profiles?.find((p) => p.id === d.senderCredentialId) ?? senders?.profiles?.[0] ?? null;
  useEffect(() => { if (senders?.profiles?.length && !d.senderCredentialId) patch({ senderCredentialId: senders.profiles[0].id, replyTo: d.replyTo ?? senders.profiles[0].replyTo ?? null }, undefined, { auto: true }); if (draft.channel === "sms" && profile && !d.senderId && profile.senders?.length) patch({ senderId: profile.senders[0].value }, undefined, { auto: true }); if (draft.channel === "whatsapp" && senders?.senders?.length && !d.senderCredentialId) patch({ senderCredentialId: (senders.senders.find((s) => s.isDefault) ?? senders.senders[0]).id }, undefined, { auto: true }); }, [senders]); // eslint-disable-line react-hooks/exhaustive-deps
  const err = (s: string) => problems.find((p) => p.message.includes(s))?.message;
  return (
    <div className="wz-form" data-testid="wz-info">
      <Field label={t("שם הקמפיין", "Campaign name")} hint={t("לשימוש פנימי, אנשי הקשר שלכם לא יראו את שם הקמפיין", "For internal use – your contacts won't see the campaign name")} error={err("שם")}><input value={draft.name} onChange={(e) => patch({}, e.target.value)} data-testid="info-name" /></Field>
      {draft.channel === "email" && <>
        <Field label={t("שורת הנושא", "Subject line")} hint={t("שורת נושא המייל שאנשי הקשר יראו בתיבת הדוא״ל", "The email subject your contacts will see in their inbox")} error={err("נושא")}><div className="wz-inline"><input value={d.subject ?? ""} onChange={(e) => patch({ subject: e.target.value })} data-testid="info-subject" /><TagPicker onPick={(tag) => patch({ subject: `${d.subject ?? ""}{{${tag}}}` })} /></div></Field>
        <Field label={t("תיאור קצר לפתיחה", "Preview text")} hint={t("הכותרת המשנית תופיע לצד או מתחת לשורת הנושא (Preheader)", "Shown next to or below the subject line (preheader)")}><input value={d.preheader ?? ""} onChange={(e) => patch({ preheader: e.target.value })} data-testid="info-preheader" /></Field>
        <Field label={t("מאת (פרופיל שליחה)", "From (sending profile)")} error={err("שולח")}><select value={d.senderCredentialId ?? ""} onChange={(e) => { const p = senders?.profiles?.find((x) => x.id === e.target.value); patch({ senderCredentialId: e.target.value || null, replyTo: p?.replyTo ?? null }); }} data-testid="info-sender">{!senders ? <option>טוען…</option> : !senders.profiles?.length ? <option value="">{t("אין חיבור אימייל פעיל", "No active email connection")}</option> : senders.profiles.map((p) => <option key={p.id} value={p.id}>{p.senderName ?? p.label} &lt;{p.senderEmail ?? "—"}&gt;{p.simulated ? t(" · הדמיה", " · simulation") : ""}</option>)}</select><ConnStatus p={senders ? profile : undefined} /></Field>
        <button type="button" className="wz-link" onClick={() => setMore((m) => !m)} data-testid="info-more">{more ? <ChevronUp size={14} /> : <ChevronDown size={14} />} {t("אפשרויות נוספות", "More options")}</button>
        {more && <div className="wz-more">
          <div className="wz-field"><span className="wz-label">{t("כתובת לתשובות (Reply-To)", "Reply-to address")}</span><span dir="ltr">{profile?.replyTo || profile?.senderEmail || "—"}</span><span className="wz-hint">{t("נקבעת בפרופיל השליחה", "Set in the sending profile")} (<Link href="/settings">{t("הגדרות → חיבורים", "Settings → Connections")}</Link>).</span></div>
          <Field label={t("סוג ההודעה", "Message type")} hint={t("שיווקי: נשלח רק למי שנתן הסכמה, עם קישור הסרה ומגבלת תדירות", "Marketing: sent only to opted-in contacts, with an unsubscribe link and frequency cap")}><select value={d.category ?? "MARKETING"} onChange={(e) => patch({ category: e.target.value })}><option value="MARKETING">{t("שיווקי", "Marketing")}</option><option value="UTILITY">{t("שירותי / תפעולי", "Service / transactional")}</option></select></Field>
          <div className="wz-track"><span className="wz-label">{t("הגדרות מעקב", "Tracking settings")}</span><ul><li>{profile?.capabilities?.opens ? t("✓ מעקב פתיחות פעיל (אות מהספק)", "✓ Open tracking on (provider signal)") : t("– הספק לא מדווח פתיחות", "– Provider does not report opens")}</li><li>{profile?.capabilities?.clicks ? t("✓ מעקב הקלקות פעיל", "✓ Click tracking on") : t("– הספק לא מדווח הקלקות", "– Provider does not report clicks")}</li><li>{t("✓ קישור הסרה אישי לכל נמען", "✓ Personal unsubscribe link for each recipient")}</li></ul><span className="wz-hint">{t("המעקב נקבע לפי החיבור", "Tracking is determined by the connection")} (<Link href="/settings">{t("הגדרות → חיבורים", "Settings → Connections")}</Link>).</span></div>
        </div>}
      </>}
      {draft.channel === "sms" && <>
        <Field label={t("חיבור SMS", "SMS connection")} error={err("חיבור")}><select value={d.senderCredentialId ?? ""} onChange={(e) => patch({ senderCredentialId: e.target.value || null, senderId: null })} data-testid="info-sender">{!senders ? <option>טוען…</option> : !senders.profiles?.length ? <option value="">{t("אין חיבור SMS פעיל", "No active SMS connection")}</option> : senders.profiles.map((p) => <option key={p.id} value={p.id}>{p.label}{p.simulated ? t(" · הדמיה", " · simulation") : ""}</option>)}</select><ConnStatus p={senders ? profile : undefined} /></Field>
        <Field label={t("שולח מאושר", "Approved sender")} hint={t("מספר או שם שולח מתוך החיבור", "Sender number or name from the connection")} error={err("שולח מאושר")}><select value={d.senderId ?? ""} onChange={(e) => patch({ senderId: e.target.value || null })} data-testid="info-sms-sender">{(profile?.senders ?? []).map((s) => <option key={s.value} value={s.value}>{s.value} ({s.type}{s.inbound ? t(", דו-כיווני", ", two-way") : ""})</option>)}{!profile?.senders?.length && <option value="">{t("אין שולחים מאושרים", "No approved senders")}</option>}</select></Field>
        <Field label={t("סוג ההודעה", "Message type")}><select value={d.category ?? "MARKETING"} onChange={(e) => patch({ category: e.target.value })}><option value="MARKETING">{t("שיווקי (עם הסרה)", "Marketing (with unsubscribe)")}</option><option value="UTILITY">{t("שירותי", "Service")}</option></select></Field>
      </>}
      {draft.channel === "whatsapp" && <>
        <Field label={t("מספר שולח (חשבון WhatsApp מחובר)", "Sender number (connected WhatsApp account)")}><select value={d.senderCredentialId ?? ""} onChange={(e) => patch({ senderCredentialId: e.target.value || null })} data-testid="info-sender">{!senders ? <option>טוען…</option> : senders.mock ? <option value="">{t("מספר הדגמה (הדמיה)", "Demo number (simulation)")}</option> : !senders.senders?.length ? <option value="">{t("אין מספר מחובר", "No connected number")}</option> : senders.senders.map((s) => <option key={s.id} value={s.id}>{s.label}{s.phone ? ` · ${s.phone}` : ""}{s.sendingBlocked ? t(" · חסום", " · blocked") : ""}</option>)}</select>{senders?.mock && <span className="wz-conn warn">{t("מצב הדמיה – לא נשלחות הודעות אמיתיות", "Simulation mode – no real messages are sent")} · <Link href="/settings/whatsapp">{t("חבר WhatsApp", "Connect WhatsApp")}</Link></span>}</Field>
      </>}
    </div>
  );
}
function TagPicker({ onPick }: { onPick: (tag: string) => void }) { const t = useT(); return <select className="wz-tagpick" value="" onChange={(e) => e.target.value && onPick(e.target.value)} aria-label={t("הוסף משתנה", "Add variable")}><option value="">{t("{ } משתנה", "{ } Variable")}</option>{BUILTIN_TAGS.filter((t) => t !== "unsubscribe_url").map((t) => <option key={t} value={t}>{t}</option>)}</select>; }

// ───────────────────────── קהל יעד ─────────────────────────
type ListRow = { id: string; name: string; dynamic: boolean; count: number | null };
function AudienceStep({ draft, patch, problems }: { draft: Draft; patch: (d: Record<string, unknown>) => void; problems: Problem[] }) {
  const t = useT();
  const loc = t.lang === "en" ? "en-GB" : "he-IL";
  const [lists, setLists] = useState<ListRow[] | null>(null);
  const [q, setQ] = useState(""); const [exOpen, setExOpen] = useState(false);
  const [preview, setPreview] = useState<{ eligible: number; remaining: number; matched: number; excluded: number; checkedAt: string } | null | "loading">(null);
  const sel = draft.data.listIds ?? []; const ex = draft.data.excludedListIds ?? [];
  useEffect(() => { api<{ lists: ListRow[] }>("/api/distribution-lists?counts=1").then((r) => setLists(r.lists)).catch(() => setLists([])); }, []);
  useEffect(() => {
    if (!sel.length) { setPreview(null); return; }
    setPreview("loading");
    const timer = setTimeout(() => api<{ eligible: number; remaining: number; matched: number; excluded: number; checkedAt: string }>("/api/distribution-lists/preview", "POST", { listIds: sel, excludedListIds: ex, channel: draft.channel, marketing: (draft.data.category ?? "MARKETING") === "MARKETING" }).then(setPreview).catch(() => setPreview(null)), 300);
    return () => clearTimeout(timer);
  }, [sel.join(","), ex.join(","), draft.channel, draft.data.category]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string) => patch({ listIds: sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id], excludedListIds: ex.filter((x) => x !== id) });
  const toggleEx = (id: string) => patch({ excludedListIds: ex.includes(id) ? ex.filter((x) => x !== id) : [...ex, id], listIds: sel.filter((x) => x !== id) });
  const visible = (lists ?? []).filter((l) => !q.trim() || l.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="wz-form wide" data-testid="wz-audience">
      <h2>{t("בחירת קהלי יעד", "Choose target audiences")}</h2>
      <p className="wz-sub">{t("ניתן לבחור יותר מקהל אחד. איש קשר שנמצא בכמה קהלים יקבל הודעה אחת בלבד.", "You can choose more than one audience. A contact in several audiences receives only one message.")}</p>
      {problems.map((p) => <p key={p.message} className="wz-err">{p.message}</p>)}
      <label className="cmp-search wz-listsearch"><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("חיפוש קהלים", "Search audiences")} aria-label={t("חיפוש קהלים", "Search audiences")} /></label>
      <div className="wz-lists" data-testid="audience-lists">
        {lists === null ? <p className="wz-hint">{t("טוען קהלים…", "Loading audiences…")}</p> : visible.length === 0 ? <p className="wz-hint">{t("אין קהלים.", "No audiences.")} <Link href="/audiences">{t("צור קהל או ייבא אנשי קשר", "Create an audience or import contacts")}</Link></p> : visible.map((l) => (
          <label key={l.id} className={`wz-list ${sel.includes(l.id) ? "on" : ""}`} data-testid={`audience-${l.id}`}><input type="checkbox" checked={sel.includes(l.id)} onChange={() => toggle(l.id)} /><span className="wz-list-name">{l.name}{l.dynamic && <em>{t("קהל דינמי", "Dynamic audience")}</em>}</span><span className="wz-list-count">{l.count === null ? "—" : t(`${l.count.toLocaleString(loc)} אנשי קשר`, `${l.count.toLocaleString(loc)} contacts`)}</span></label>
        ))}
      </div>
      <button type="button" className="wz-link" onClick={() => setExOpen((o) => !o)} data-testid="audience-exclude-toggle">{exOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />} {t("החרגת קהלים", "Exclude audiences")}{ex.length ? ` (${ex.length})` : ""}</button>
      {exOpen && <div className="wz-lists small">{(lists ?? []).filter((l) => !sel.includes(l.id)).map((l) => <label key={l.id} className={`wz-list ${ex.includes(l.id) ? "on ex" : ""}`}><input type="checkbox" checked={ex.includes(l.id)} onChange={() => toggleEx(l.id)} /><span className="wz-list-name">{l.name}</span><span className="wz-list-count">{l.count === null ? "—" : l.count.toLocaleString(loc)}</span></label>)}</div>}
      <div className="wz-total" data-testid="audience-total">
        {preview === "loading" ? <span>{t("מחשב…", "Calculating…")}</span> : preview ? <><strong>{preview.eligible.toLocaleString(loc)}</strong> {t(`נמענים ייחודיים זכאים לקבלת הודעה ב${CHANNEL_LABELS[draft.channel]}`, `unique recipients eligible to receive a ${CHANNEL_LABELS[draft.channel]} message`)}<span className="wz-hint">{t(`מתוך ${preview.remaining.toLocaleString(loc)} בקהלים שנבחרו`, `out of ${preview.remaining.toLocaleString(loc)} in the selected audiences`)}{preview.excluded ? t(` (הוחרגו ${preview.excluded.toLocaleString(loc)})`, ` (${preview.excluded.toLocaleString(loc)} excluded)`) : ""}{t(". הזכאות (הסכמה, הסרות, חסימות, כתובת/מספר תקין, תדירות) מחושבת מחדש בזמן השליחה – הכמות עשויה להשתנות.", ". Eligibility (consent, unsubscribes, blocks, valid address/number, frequency) is recalculated at send time – the count may change.")}</span></> : <span>{t("סה״כ אנשי קשר: 0 – בחר קהל", "Total contacts: 0 – choose an audience")}</span>}
      </div>
    </div>
  );
}

// ───────────────────────── תבנית ─────────────────────────
type EmailTpl = { id: string; name: string; subject: string | null; preheader: string | null; design: unknown; updatedAt?: string };
type WaTpl = { id: string; name: string; language: string; status: string; category: string; body: string; headerFormat: string | null; buttons: Array<{ type: string; text: string; url?: string; dynamic?: boolean }> | null };
function TemplateStep({ draft, patch, problems }: { draft: Draft; patch: (d: Record<string, unknown>) => void; problems: Problem[] }) {
  const t = useT();
  const [mine, setMine] = useState<EmailTpl[] | null>(null);
  const [wa, setWa] = useState<WaTpl[] | null>(null);
  const [q, setQ] = useState(""); const [tab, setTab] = useState<"mine" | "starters">("starters");
  const [preview, setPreview] = useState<{ name: string; html: string } | null>(null);
  useEffect(() => { if (draft.channel === "email") api<{ data: { items: EmailTpl[] } }>("/api/channels/email/templates").then((r) => setMine(r.data.items.filter((t) => t.design))).catch(() => setMine([])); else api<{ templates: WaTpl[] }>("/api/templates").then((r) => setWa(r.templates)).catch(() => setWa([])); }, [draft.channel]);
  useEffect(() => { if (draft.channel === "email" && mine && mine.length && draft.data.designSource === "blank") setTab("mine"); }, [mine]); // eslint-disable-line react-hooks/exhaustive-deps
  if (draft.channel === "whatsapp") {
    const list = (wa ?? []).filter((t) => !q.trim() || t.name.toLowerCase().includes(q.trim().toLowerCase()));
    return <div className="wz-form wide" data-testid="wz-template"><h2>{t("תבנית WhatsApp", "WhatsApp template")}</h2><p className="wz-sub">{t("רק תבניות מאושרות מהחשבון המחובר ניתנות לשליחה (דרישת Meta).", "Only approved templates from the connected account can be sent (Meta requirement).")}</p>{problems.map((p) => <p key={p.message} className="wz-err">{p.message}</p>)}
      <label className="cmp-search wz-listsearch"><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("חיפוש תבנית", "Search template")} /></label>
      <div className="wz-lists">{wa === null ? <p className="wz-hint">{t("טוען…", "Loading…")}</p> : list.length === 0 ? <p className="wz-hint">{t("אין תבניות מאושרות.", "No approved templates.")} <Link href="/templates">{t("לניהול תבניות וסנכרון", "Manage & sync templates")}</Link></p> : list.map((tp) => <label key={tp.id} className={`wz-list ${draft.data.templateId === tp.id ? "on" : ""}`} data-testid={`template-${tp.id}`}><input type="radio" name="tpl" checked={draft.data.templateId === tp.id} onChange={() => patch({ templateId: tp.id, variables: {}, mediaUrl: null, buttonParams: null })} /><span className="wz-list-name">{tp.name}<em>{tp.language} · {tp.category} · {tp.status === "APPROVED" ? t("מאושרת", "Approved") : tp.status}</em><small>{tp.body.slice(0, 140)}</small></span></label>)}</div></div>;
  }
  const pick = (design: EmailDesign, source: string) => { patch({ design: JSON.parse(JSON.stringify(design)), designSource: source }); toast.success(t("התבנית הועתקה לקמפיין – המקור לא ישתנה", "Template copied to the campaign – the original won't change")); };
  const mineList = (mine ?? []).filter((t) => !q.trim() || t.name.toLowerCase().includes(q.trim().toLowerCase()));
  const starters = EMAIL_STARTERS.filter((s) => !q.trim() || s.name.includes(q.trim()));
  return (
    <div className="wz-form wide" data-testid="wz-template">
      <h2>{t("בחירת תבנית", "Choose a template")}</h2><p className="wz-sub">{t("הקמפיין מקבל עותק של התבנית; עריכה כאן לא משנה את התבנית המקורית.", "The campaign gets a copy of the template; editing here does not change the original.")}</p>
      {problems.map((p) => <p key={p.message} className="wz-err">{p.message}</p>)}
      <div className="wz-gallery-head"><div className="wz-seg"><button className={tab === "mine" ? "active" : ""} onClick={() => setTab("mine")} data-testid="gallery-mine">{t("התבניות שלי", "My templates")} ({mine?.length ?? 0})</button><button className={tab === "starters" ? "active" : ""} onClick={() => setTab("starters")} data-testid="gallery-starters">{t("תבניות מוכנות", "Ready-made templates")}</button></div><label className="cmp-search"><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("חיפוש", "Search")} /></label></div>
      <div className="wz-gallery">
        <article className={`wz-card blank ${draft.data.designSource === "blank" ? "on" : ""}`}><div className="wz-card-preview"><span>+</span></div><h4>{t("התחלה מתבנית ריקה", "Start from blank")}</h4><button className="wz-btn small" onClick={() => pick(emailDesignSchema.parse({ blocks: [{ type: "heading", text: "כותרת" }, { type: "text", text: "הטקסט שלך כאן" }, { type: "footer", text: "" }] }), "blank")} data-testid="gallery-blank">{t("בחר", "Select")}</button></article>
        {(tab === "mine" ? mineList.map((t) => ({ key: t.id, name: t.name, desc: t.subject ?? "", design: emailDesignSchema.safeParse(t.design).data ?? null })) : starters.map((s) => ({ key: `starter:${s.key}`, name: s.name, desc: s.description, design: emailDesignSchema.safeParse(s.design).data ?? null }))).map((c) => c.design ? (
          <article key={c.key} className={`wz-card ${draft.data.designSource === c.key ? "on" : ""}`} data-testid={`gallery-${c.key}`}>
            <div className="wz-card-preview"><iframe title={c.name} srcDoc={renderEmailHtml(c.design)} sandbox="" tabIndex={-1} /></div>
            <h4>{c.name}</h4><p>{c.desc}</p>
            <div className="wz-card-actions"><button className="wz-btn small ghost" onClick={() => setPreview({ name: c.name, html: renderEmailHtml(c.design!) })}>{t("תצוגה מקדימה", "Preview")}</button><button className="wz-btn small" onClick={() => pick(c.design!, c.key)}>{draft.data.designSource === c.key ? t("נבחר ✓", "Selected ✓") : t("בחר", "Select")}</button></div>
          </article>) : null)}
        {tab === "mine" && mine && mine.length === 0 && <p className="wz-hint">{t("אין תבניות אימייל שמורות.", "No saved email templates.")} <Link href="/templates">{t("ניהול תבניות", "Manage templates")}</Link></p>}
      </div>
      {preview && <div className="wz-modal" role="dialog" aria-label={preview.name}><div className="wz-modal-box"><header><strong>{preview.name}</strong><button onClick={() => setPreview(null)} aria-label={t("סגור", "Close")}><X size={18} /></button></header><iframe title="preview" srcDoc={preview.html} sandbox="" /></div></div>}
    </div>
  );
}

// ───────────────────────── תוכן ─────────────────────────
function ContentStep({ draft, patch, flush, problems }: { draft: Draft; patch: (d: Record<string, unknown>) => void; flush: () => Promise<void>; problems: Problem[] }) {
  const t = useT();
  const [testTo, setTestTo] = useState(draft.data.testTo ?? "");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const senders = useSenders(draft.channel);
  const profile = senders?.profiles?.find((p) => p.id === draft.data.senderCredentialId) ?? senders?.profiles?.[0] ?? null;
  const sendTest = async () => { setBusy(true); try { await flush(); const r = await api<{ data?: { simulated?: boolean } }>(`/api/campaigns/drafts/${draft.id}/test`, "POST", { to: testTo }); toast.success(r.data?.simulated ? t(`הדמיה: הודעת בדיקה נשלחה ל-${testTo}`, `Simulation: test message sent to ${testTo}`) : t(`הודעת בדיקה נשלחה ל-${testTo}`, `Test message sent to ${testTo}`)); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } };
  const testBar = <div className="wz-testbar"><input dir="ltr" placeholder={draft.channel === "email" ? t("נמען בדיקה (מוגדר בחיבור)", "Test recipient (set in connection)") : t("מספר בדיקה מורשה", "Authorized test number")} value={testTo} onChange={(e) => setTestTo(e.target.value)} aria-label={t("נמען בדיקה", "Test recipient")} data-testid="content-test-to" list="test-recipients" /><datalist id="test-recipients">{(profile?.testRecipients ?? []).map((r) => <option key={r} value={r} />)}</datalist><button className="wz-btn ghost" disabled={busy || !testTo} onClick={sendTest} data-testid="content-test-send">{t("שליחת ניסיון", "Send test")}</button><button className="wz-btn ghost" onClick={() => setPreview((p) => !p)}>{preview ? t("סגור תצוגה", "Close preview") : t("תצוגה מקדימה", "Preview")}</button></div>;
  if (draft.channel === "email") {
    const raw = draft.data.design as Partial<EmailDesign> | undefined;
    const parsed = emailDesignSchema.safeParse(raw);
    // While the user is mid-edit a field can be briefly invalid (empty text, partial width) – keep editing the real design.
    const design: EmailDesign = parsed.success ? parsed.data : raw && Array.isArray(raw.blocks) ? { version: 1, settings: { ...emailDesignSchema.parse({ blocks: [{ type: "divider" }] }).settings, ...(raw.settings ?? {}) }, blocks: raw.blocks } as EmailDesign : emailDesignSchema.parse({ blocks: [{ type: "text", text: "הטקסט שלך" }] });
    return <div className="wz-content" data-testid="wz-content">{problems.map((p) => <p key={p.message} className="wz-err">{p.message}</p>)}{testBar}
      {preview ? <div className="wz-preview"><iframe title={t("תצוגה מקדימה", "Preview")} srcDoc={renderEmailHtml(design, { preheader: draft.data.preheader })} sandbox="" /></div> : <EmailEditor design={design} preheader={draft.data.preheader} onChange={(d) => patch({ design: d })} />}
    </div>;
  }
  if (draft.channel === "sms") return <SmsContent draft={draft} patch={patch} problems={problems} testBar={testBar} unitPrice={profile?.unitPrice ?? null} currency={profile?.currency ?? null} />;
  return <WhatsAppContent draft={draft} patch={patch} problems={problems} testBar={testBar} />;
}
function SmsContent({ draft, patch, problems, testBar, unitPrice, currency }: { draft: Draft; patch: (d: Record<string, unknown>) => void; problems: Problem[]; testBar: React.ReactNode; unitPrice: number | null; currency: string | null }) {
    const t = useT();
    const body = draft.data.body ?? "";
    const footer = (draft.data.category ?? "MARKETING") === "MARKETING" ? "\nלהסרה השיבו הסר" : "";
    const m = smsMetrics(body + footer);
    const extra = mergeTagsOf(body).filter((t) => !BUILTIN_TAGS.includes(t.tag) && !t.tag.startsWith("custom."));
    const ta = useRef<HTMLTextAreaElement>(null);
    const insert = (tag: string) => { const el = ta.current; const s = el?.selectionStart ?? body.length; const v = `${body.slice(0, s)}{{${tag}}}${body.slice(s)}`; patch({ body: v }); };
    return <div className="wz-content sms" data-testid="wz-content">{problems.map((p) => <p key={p.message} className="wz-err">{p.message}</p>)}{testBar}
      <div className="wz-sms">
        <div className="wz-sms-edit"><label className="wz-field"><span className="wz-label">{t("תוכן ההודעה", "Message content")}</span><textarea ref={ta} rows={8} value={body} onChange={(e) => patch({ body: e.target.value })} data-testid="sms-body" /></label>
          <div className="wz-tags">{BUILTIN_TAGS.filter((t) => t !== "unsubscribe_url" && t !== "email").map((t) => <button key={t} type="button" onClick={() => insert(`${t}|`)}>{`{{${t}}}`}</button>)}</div>
          <p className="wz-hint" data-testid="sms-metrics">{t(`קידוד ${m.encoding} · ${m.length} תווים · `, `${m.encoding} encoding · ${m.length} characters · `)}<b>{m.segments}</b>{t(" מקטעים לנמען", " segments per recipient")}{footer ? t(" (כולל שורת הסרה)", " (including unsubscribe line)") : ""}{unitPrice != null ? t(` · אומדן ${(m.segments * unitPrice).toFixed(3)} ${currency ?? ""} לנמען (מחיר יחידה ידני)`, ` · est. ${(m.segments * unitPrice).toFixed(3)} ${currency ?? ""} per recipient (manual unit price)`) : t(" · עלות: לא מחובר תמחור", " · cost: no pricing connected")}</p>
          {extra.length > 0 && <div className="wz-more"><span className="wz-label">{t("ערכים למשתנים מותאמים", "Values for custom variables")}</span>{extra.map((tg) => <label key={tg.tag} className="wz-field"><span className="wz-label">{`{{${tg.tag}}}`}{tg.fallback !== null ? t(` (ברירת מחדל: ${tg.fallback})`, ` (default: ${tg.fallback})`) : ""}</span><input value={draft.data.variables?.[tg.tag] ?? ""} onChange={(e) => patch({ variables: { ...(draft.data.variables ?? {}), [tg.tag]: e.target.value } })} /></label>)}</div>}
        </div>
        <div className="wz-phone" aria-label={t("תצוגת טלפון", "Phone preview")}><div className="wz-phone-screen"><div className="wz-bubble">{(body || t("ההודעה שלך תוצג כאן", "Your message will appear here")).replace(/\{\{(\w+)\|?([^}]*)\}\}/g, (_, tag, f) => f || (tag === "first_name" ? "ישראל" : tag === "name" ? "ישראל ישראלי" : `[${tag}]`))}{footer}</div></div></div>
      </div>
    </div>;
  }
function WhatsAppContent({ draft, patch, problems, testBar }: { draft: Draft; patch: (d: Record<string, unknown>) => void; problems: Problem[]; testBar: React.ReactNode }) {
  const t = useT();
  const [tpl, setTpl] = useState<WaTpl | null>(null);
  useEffect(() => { api<{ templates: WaTpl[] }>("/api/templates").then((r) => setTpl(r.templates.find((t) => t.id === draft.data.templateId) ?? null)).catch(() => undefined); }, [draft.data.templateId]);
  if (!tpl) return <div className="wz-content" data-testid="wz-content"><p className="wz-hint">{draft.data.templateId ? t("טוען תבנית…", "Loading template…") : t("בחר תבנית בשלב הקודם.", "Choose a template in the previous step.")}</p></div>;
  const keys = templateParameterKeys(tpl.body); const vars = draft.data.variables ?? {};
  const header = (tpl.headerFormat ?? "").toUpperCase(); const needsMedia = ["IMAGE", "VIDEO", "DOCUMENT"].includes(header);
  const dyn = (tpl.buttons ?? []).map((b, i) => ({ ...b, index: i })).filter((b) => b.type === "URL" && b.dynamic);
  return <div className="wz-content" data-testid="wz-content">{problems.map((p) => <p key={p.message} className="wz-err">{p.message}</p>)}{testBar}
    <div className="wz-sms">
      <div className="wz-sms-edit">
        {keys.map((k) => <label key={k} className="wz-field"><span className="wz-label">{t("משתנה", "Variable")} {`{{${k}}}`}</span><input value={vars[k] ?? ""} onChange={(e) => patch({ variables: { ...vars, [k]: e.target.value } })} placeholder={t("ערך קבוע, או {name} לשם הלקוח", "A fixed value, or {name} for the customer's name")} data-testid={`wa-var-${k}`} /></label>)}
        {needsMedia && <label className="wz-field"><span className="wz-label">{t("מדיה לכותרת", "Header media")} ({header === "IMAGE" ? t("תמונה", "Image") : header === "VIDEO" ? t("וידאו", "Video") : t("מסמך", "Document")}) – {t("קישור https ציבורי", "public https link")}</span><input dir="ltr" value={draft.data.mediaUrl ?? ""} onChange={(e) => patch({ mediaUrl: e.target.value || null })} /></label>}
        {dyn.map((b) => <label key={b.index} className="wz-field"><span className="wz-label">{t(`כפתור "${b.text}" – סיומת הקישור (${b.url})`, `Button "${b.text}" – link suffix (${b.url})`)}</span><input dir="ltr" value={draft.data.buttonParams?.[String(b.index)] ?? ""} onChange={(e) => patch({ buttonParams: { ...(draft.data.buttonParams ?? {}), [String(b.index)]: e.target.value } })} /></label>)}
        {!keys.length && !needsMedia && !dyn.length && <p className="wz-hint">{t("לתבנית זו אין משתנים – אפשר להמשיך לבקרה.", "This template has no variables – you can continue to review.")}</p>}
      </div>
      <div className="wz-phone wa" aria-label={t("תצוגת הודעה", "Message preview")}><div className="wz-phone-screen">{needsMedia && <div className="wz-media">{draft.data.mediaUrl ? (header === "IMAGE" ? <img src={draft.data.mediaUrl} alt="" /> : <span>{header}</span>) : <span>{t("מדיה", "Media")}</span>}</div>}<div className="wz-bubble">{renderTemplate(tpl.body, Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, v.replaceAll("{name}", "ישראל")])))}</div>{(tpl.buttons ?? []).map((b, i) => <div key={i} className="wz-wa-btn">{b.text}</div>)}</div></div>
    </div>
  </div>;
}

// ───────────────────────── בקרה ─────────────────────────
type Preflight = { eligible: number; totalQueued: number; audienceExcluded: number; exclusions: Record<string, number>; blockers: string[]; samples: Array<{ name: string; body: string; subject?: string; phone: string }>; sender: string; simulated: boolean; cost: { total: number | null; currency: string | null; known: boolean; units: number } | null; timezone?: string; sendWindow?: { start: string; end: string; maxPerMinute?: number } | null };
function ReviewStep({ draft, patch, problems, flush, go, onSent }: { draft: Draft; patch: (d: Record<string, unknown>) => void; problems: Problem[]; flush: () => Promise<void>; go: (s: Step) => Promise<void>; onSent: () => void }) {
  const t = useT();
  const loc = t.lang === "en" ? "en-GB" : "he-IL";
  const [state, setState] = useState<{ campaignId: string; preflight: Preflight } | null>(null);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [when, setWhen] = useState("");
  const [confirm, setConfirm] = useState<"now" | "schedule" | null>(null);
  const [sending, setSending] = useState(false);
  const [testTo, setTestTo] = useState(draft.data.testTo ?? "");
  const throttle = (draft.data.throttle as Throttle | null | undefined) ?? null;
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
      await api(`/api/campaigns/${state.campaignId}`, "PATCH", { action: "start", scheduledAt, scheduledTimezone: scheduledAt ? tz : undefined, throttle });
      toast.success(scheduledAt ? t("הקמפיין תוזמן", "Campaign scheduled") : t("הקמפיין יצא לשליחה", "Campaign is sending")); onSent();
    } catch (e) { toast.error((e as Error).message); setSending(false); setConfirm(null); }
  };
  const sendTest = async () => { try { const r = await api<{ data?: { simulated?: boolean } }>(`/api/campaigns/drafts/${draft.id}/test`, "POST", { to: testTo }); toast.success(r.data?.simulated ? t("הדמיה: הודעת בדיקה נשלחה", "Simulation: test message sent") : t("הודעת בדיקה נשלחה", "Test message sent")); } catch (e) { toast.error((e as Error).message); } };
  const pf = state?.preflight;
  const rows: Array<{ label: string; ok: boolean | null; detail: string; step: Step }> = [
    { label: t("שולח וחיבור", "Sender & connection"), ok: pf ? !pf.blockers.some((b) => b.includes("חיבור") || b.includes("דומיין")) : problems.some((p) => p.step === "info") ? false : null, detail: pf?.sender ?? (problems.find((p) => p.step === "info")?.message ?? t("ייבדק אחרי בניית הקמפיין", "Will be checked after the campaign is built")), step: "info" },
    { label: t("קהל יעד", "Audience"), ok: pf ? pf.eligible > 0 : problems.some((p) => p.step === "audience") ? false : null, detail: pf ? t(`${pf.eligible.toLocaleString(loc)} נמענים זכאים מתוך ${pf.totalQueued.toLocaleString(loc)}`, `${pf.eligible.toLocaleString(loc)} eligible recipients out of ${pf.totalQueued.toLocaleString(loc)}`) + (Object.keys(pf.exclusions).length ? t(" · לא זכאים: ", " · not eligible: ") + Object.entries(pf.exclusions).map(([k, v]) => `${k} (${v})`).join(", ") : "") : (problems.find((p) => p.step === "audience")?.message ?? "—"), step: "audience" },
    { label: draft.channel === "whatsapp" ? t("תבנית מאושרת", "Approved template") : t("תוכן ותבנית", "Content & template"), ok: pf ? !pf.blockers.some((b) => b.includes("תבנית")) : problems.some((p) => p.step === "content" || p.step === "template") ? false : null, detail: pf ? (pf.blockers.find((b) => b.includes("תבנית")) ?? t("התוכן תקין ונשמר כעותק לקמפיין", "Content is valid and saved as a copy for the campaign")) : (problems.find((p) => p.step === "content" || p.step === "template")?.message ?? "—"), step: draft.channel === "whatsapp" ? "template" : "content" },
    { label: t("משתנים אישיים וערכי גיבוי", "Personalization variables & fallbacks"), ok: pf ? !(pf.exclusions["משתנים חסרים"]) : null, detail: pf ? (pf.exclusions["משתנים חסרים"] ? t(`${pf.exclusions["משתנים חסרים"]} נמענים עם משתנים חסרים ללא ברירת מחדל – הוסף ברירת מחדל ({{first_name|לקוח}})`, `${pf.exclusions["משתנים חסרים"]} recipients with missing variables and no default – add a default ({{first_name|customer}})`) : t("לכל המשתנים יש ערך או ברירת מחדל", "All variables have a value or default")) : "—", step: "content" },
    { label: t("קישורים ומנגנון הסרה", "Links & unsubscribe"), ok: true, detail: draft.channel === "email" ? t("קישור הסרה אישי מתווסף לכל מייל", "A personal unsubscribe link is added to every email") : draft.channel === "sms" ? ((draft.data.category ?? "MARKETING") === "MARKETING" ? t("שורת 'להסרה השיבו הסר' מתווספת", "An unsubscribe line ('reply הסר to opt out') is appended") : t("הודעה שירותית – ללא שורת הסרה", "Service message – no unsubscribe line")) : t("תשובת 'הסר' מסירה מדיוור אוטומטית", "Replying 'הסר' unsubscribes automatically"), step: "content" },
    ...(draft.channel === "email" ? [{ label: t("הגדרות מעקב", "Tracking settings"), ok: true as boolean | null, detail: `${profile?.capabilities?.opens ? t("פתיחות ✓", "Opens ✓") : t("פתיחות –", "Opens –")} · ${profile?.capabilities?.clicks ? t("הקלקות ✓", "Clicks ✓") : t("הקלקות –", "Clicks –")} ${t("(לפי הספק)", "(per provider)")}`, step: "info" as Step }] : []),
    { label: t("קצב שליחה", "Sending pace"), ok: true, detail: throttle ? `${throttleLabel(throttle)} · ` + t(`כ-${Math.max(1, Math.ceil((pf?.eligible ?? 0) / throttle.batchSize))} סבבים`, `~${Math.max(1, Math.ceil((pf?.eligible ?? 0) / throttle.batchSize))} rounds`) : throttleLabel(null), step: "review" as Step },
    { label: t("מועד שליחה ואזור זמן", "Send time & time zone"), ok: true, detail: when ? t(`מתוזמן ל-${new Date(when).toLocaleString(loc)} (${pf?.timezone ?? tz})`, `Scheduled for ${new Date(when).toLocaleString(loc)} (${pf?.timezone ?? tz})`) : t(`שליחה מיידית (${pf?.timezone ?? tz})`, `Immediate send (${pf?.timezone ?? tz})`) + (pf?.sendWindow ? t(` · חלון שליחה ${pf.sendWindow.start}–${pf.sendWindow.end}`, ` · send window ${pf.sendWindow.start}–${pf.sendWindow.end}`) : ""), step: "review" },
  ];
  const blockers = [...(pf?.blockers ?? []), ...problems.map((p) => p.message), ...(error ? [error] : [])];
  const canSend = Boolean(state) && blockers.length === 0 && (pf?.eligible ?? 0) > 0 && !sending;
  return (
    <div className="wz-form wide" data-testid="wz-review">
      <h2>{t("הקמפיין מוכן לשליחה?", "Is the campaign ready to send?")}</h2><p className="wz-sub">{t("יש לוודא שכל ההגדרות נכונות לפני שליחת הקמפיין. מומלץ לבצע \"שליחת ניסיון\" טרם השליחה האמיתית.", "Make sure all settings are correct before sending. We recommend a \"test send\" before the real send.")}</p>
      {pf?.simulated && <div className="wz-sim">{t("מצב הדמיה: הספק מדומה – לא יישלחו הודעות אמיתיות.", "Simulation mode: the provider is simulated – no real messages will be sent.")}</div>}
      {building && <p className="wz-hint">{t("בונה את הקמפיין ובודק את הקהל…", "Building the campaign and checking the audience…")}</p>}
      {error && <p className="wz-err">{error} <button className="wz-link" onClick={build}>{t("נסה שוב", "Retry")}</button></p>}
      <ul className="wz-checks" data-testid="review-checks">{rows.map((r) => <li key={r.label} className={r.ok === false ? "bad" : r.ok ? "ok" : ""}><span className="wz-check-icon">{r.ok === false ? "✕" : r.ok ? "✓" : "…"}</span><div><strong>{r.label}</strong><p>{r.detail}</p></div>{r.step !== "review" && <button className="wz-btn small ghost" onClick={() => go(r.step)}>{t("עריכה", "Edit")}</button>}</li>)}</ul>
      {pf && pf.samples.length > 0 && <details className="wz-samples"><summary>{t("דוגמאות להודעה כפי שתתקבל", "Message samples as received")} ({pf.samples.length})</summary>{pf.samples.map((s, i) => <div key={i} className="wz-sample"><strong>{s.name}</strong> <span dir="ltr">{s.phone}</span>{s.subject && <p><b>{t("נושא:", "Subject:")}</b> {s.subject}</p>}<pre>{s.body}</pre></div>)}</details>}
      <div className="wz-total"><strong>{(pf?.eligible ?? 0).toLocaleString(loc)}</strong> {t("נמענים ישלחו", "recipients will be sent")}{pf?.cost?.known && pf.cost.total !== null ? <span className="wz-hint">{t(` · אומדן עלות ${pf.cost.total} ${pf.cost.currency ?? ""} (לפי מחיר יחידה ידני)`, ` · estimated cost ${pf.cost.total} ${pf.cost.currency ?? ""} (manual unit price)`)}</span> : null}</div>
      <div className="wz-testbar"><input dir="ltr" placeholder={draft.channel === "whatsapp" ? t("מספר בדיקה מורשה", "Authorized test number") : t("נמען בדיקה (מוגדר בחיבור)", "Test recipient (set in connection)")} value={testTo} onChange={(e) => setTestTo(e.target.value)} aria-label={t("נמען בדיקה", "Test recipient")} data-testid="review-test-to" /><button className="wz-btn ghost" disabled={!testTo || !state} onClick={sendTest} data-testid="review-test-send">{t("שליחת ניסיון", "Send test")}</button></div>
      <div className="wz-pace" data-testid="review-pace">
        <span className="wz-label">{t("קצב שליחה", "Sending pace")}</span>
        <PaceEditor throttle={throttle} onChange={(tt) => patch({ throttle: tt })} eligible={pf?.eligible ?? null} metaLimit={draft.channel === "whatsapp" ? ((senders as { metaLimit?: MetaLimit | null } | null)?.metaLimit ?? null) : null} />
      </div>
      <div className="wz-sendbar">
        <label className="wz-field inline"><span className="wz-label">{t("תזמון (אופציונלי)", "Schedule (optional)")}</span><input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} data-testid="review-when" /></label>
        <button className="wz-btn ghost" disabled={!canSend || !when} onClick={() => setConfirm("schedule")} data-testid="review-schedule">{t("תזמון", "Schedule")}</button>
        <button className="wz-btn primary big" disabled={!canSend} onClick={() => setConfirm("now")} data-testid="review-send-now">{t("שליחה עכשיו", "Send now")}</button>
      </div>
      {blockers.length > 0 && <ul className="wz-blockers">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
      {confirm && state && <div className="wz-modal" role="dialog" aria-label={t("אישור שליחה", "Confirm send")}><div className="wz-modal-box small"><header><strong>{confirm === "now" ? t("לשלוח עכשיו?", "Send now?") : t("לתזמן את הקמפיין?", "Schedule the campaign?")}</strong><button onClick={() => !sending && setConfirm(null)} aria-label={t("סגור", "Close")}><X size={18} /></button></header>
        <dl className="wz-confirm"><dt>{t("ערוץ", "Channel")}</dt><dd>{CHANNEL_LABELS[draft.channel]}</dd><dt>{t("קמפיין", "Campaign")}</dt><dd>{draft.name}</dd><dt>{t("קהל", "Audience")}</dt><dd>{pf?.eligible.toLocaleString(loc)} {t("נמענים זכאים", "eligible recipients")}</dd><dt>{t("מועד", "Time")}</dt><dd>{confirm === "schedule" ? new Date(when).toLocaleString(loc) : t("מיידי", "Immediate")} ({tz})</dd><dt>{t("קצב", "Pace")}</dt><dd>{throttleLabel(throttle)}</dd>{pf?.simulated && <><dt>{t("מצב", "Mode")}</dt><dd>{t("הדמיה – ללא שליחה אמיתית", "Simulation – no real sending")}</dd></>}</dl>
        <p className="wz-hint">{t("הזכאות (הסכמה, הסרות, חסימות, תדירות) נבדקת שוב לכל נמען בזמן השליחה.", "Eligibility (consent, unsubscribes, blocks, frequency) is re-checked for each recipient at send time.")}</p>
        <div className="wz-modal-actions"><button className="wz-btn ghost" disabled={sending} onClick={() => setConfirm(null)}>{t("ביטול", "Cancel")}</button><button className="wz-btn primary" disabled={sending} onClick={send} data-testid="review-confirm">{sending ? t("שולח…", "Sending…") : confirm === "now" ? t("אשר ושלח", "Confirm & send") : t("אשר ותזמן", "Confirm & schedule")}</button></div></div></div>}
    </div>
  );
}
