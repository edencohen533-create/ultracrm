"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Input, Panel, Select, Spinner, Textarea, cx } from "@/components/ui";
import { formatDateTime } from "@/lib/client/format";
import { CoachReport } from "./CoachReport";
import { useT } from "@/components/i18n/LangProvider";

type Knowledge = { description: string; audience: string; products: Array<{ name: string; price?: string; notes?: string }>; benefits: string[]; faqs: Array<{ question: string; answer: string }>; objections: Array<{ objection: string; response: string }>; forbiddenClaims: string[]; style: string; callGoal: string };
type Example = { id: string; callId: string | null; objection: string; agentResponse: string; editedResponse: string | null; stage: string | null; outcome: "won" | "lost" | "unknown"; quote: string; status: "pending" | "approved" | "rejected"; createdAt: string };
type Providers = { llm: string; stt: string; embeddings: string; mock: boolean };

const linesToPairs = (text: string, sep = "|") => text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [a, ...rest] = l.split(sep); return [a.trim(), rest.join(sep).trim()] as [string, string]; });
const OUTCOME = { won: ["נסגרה", "good", "Closed"], lost: ["לא נסגרה", "bad", "Not closed"], unknown: ["ללא תוצאה", "neutral", "No outcome"] } as const;

/** Manager settings for the coach: on/off (business + per agent), approved knowledge, example review, provider status. */
export function CoachAdmin({ isAdmin }: { isAdmin: boolean }) {
  const t = useT();
  const [settings, setSettings] = useState<{ enabled: boolean; learnFromRecordings: boolean } | null>(null);
  const [providers, setProviders] = useState<Providers | null>(null);
  const [users, setUsers] = useState<Array<{ id: string; fullName: string; role: string; coachEnabled: boolean; isActive: boolean }>>([]);
  const [k, setK] = useState<Knowledge | null>(null);
  const [text, setText] = useState({ products: "", benefits: "", faqs: "", objections: "", forbidden: "" });
  const [examples, setExamples] = useState<Example[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [exStatus, setExStatus] = useState<"pending" | "approved" | "rejected">("pending");
  const [edit, setEdit] = useState<Record<string, string>>({});

  const loadExamples = useCallback(() => api.get<{ items: Example[]; counts: Record<string, number> }>(`/api/coach/examples?status=${exStatus}&limit=100`).then((r) => { setExamples(r.items); setCounts(r.counts); }).catch((e) => toast.error(e.message)), [exStatus]);
  useEffect(() => {
    api.get<{ settings: { coach: { enabled: boolean; learnFromRecordings: boolean } } }>("/api/settings").then((r) => setSettings(r.settings.coach)).catch((e) => toast.error(e.message));
    api.get<{ providers: Providers }>("/api/coach/metrics?days=1").then((r) => setProviders(r.providers)).catch(() => undefined);
    api.get<{ items: typeof users }>("/api/users").then((r) => setUsers(r.items)).catch(() => undefined);
    api.get<Knowledge>("/api/coach/knowledge").then((r) => { setK(r); setText({ products: r.products.map((p) => [p.name, p.price ?? "", p.notes ?? ""].join(" | ")).join("\n"), benefits: r.benefits.join("\n"), faqs: r.faqs.map((f) => `${f.question} | ${f.answer}`).join("\n"), objections: r.objections.map((o) => `${o.objection} | ${o.response}`).join("\n"), forbidden: r.forbiddenClaims.join("\n") }); }).catch((e) => toast.error(e.message));
  }, []);
  useEffect(() => { loadExamples(); }, [loadExamples]);

  async function saveSettings(patch: Partial<{ enabled: boolean; learnFromRecordings: boolean }>) {
    if (!settings) return;
    const next = { ...settings, ...patch }; setSettings(next);
    try { await api.patch("/api/settings", { settings: { coach: next } }); toast.success(t("נשמר", "Saved")); } catch (e) { toast.error((e as Error).message); }
  }
  async function toggleUser(id: string, coachEnabled: boolean) {
    setUsers((u) => u.map((x) => x.id === id ? { ...x, coachEnabled } : x));
    try { await api.patch(`/api/users/${id}`, { coachEnabled }); } catch (e) { toast.error((e as Error).message); }
  }
  async function saveKnowledge() {
    if (!k) return;
    const body = {
      description: k.description, audience: k.audience, style: k.style, callGoal: k.callGoal,
      products: text.products.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [name, price, notes] = l.split("|").map((x) => x.trim()); return { name, price: price || undefined, notes: notes || undefined }; }),
      benefits: text.benefits.split("\n").map((l) => l.trim()).filter(Boolean),
      faqs: linesToPairs(text.faqs).map(([question, answer]) => ({ question, answer })),
      objections: linesToPairs(text.objections).map(([objection, response]) => ({ objection, response })),
      forbiddenClaims: text.forbidden.split("\n").map((l) => l.trim()).filter(Boolean),
    };
    try { await api.put("/api/coach/knowledge", body); toast.success(t("הידע העסקי נשמר", "Business knowledge saved")); } catch (e) { toast.error((e as Error).message); }
  }
  async function review(ex: Example, status: "approved" | "rejected") {
    try { await api.patch(`/api/coach/examples/${ex.id}`, { status, editedResponse: edit[ex.id] !== undefined ? (edit[ex.id] || null) : undefined }); toast.success(status === "approved" ? t("אושר לשימוש", "Approved for use") : t("נפסל", "Rejected")); loadExamples(); } catch (e) { toast.error((e as Error).message); }
  }

  if (!settings || !k) return <Spinner />;
  const keyBadge = (v: string) => v === "missing" ? <Badge tone="bad">{t("חסר", "Missing")}</Badge> : v === "mock" ? <Badge tone="warn">{t("מדומה", "Mock")}</Badge> : v === "keyword" ? <Badge tone="neutral">{t("מילות מפתח", "Keywords")}</Badge> : <Badge tone="good">{v}</Badge>;
  return (
    <div className="space-y-4">
      <Panel title={t("מאמן מכירות בזמן אמת", "Real-time sales coach")}>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={settings.enabled} disabled={!isAdmin} onChange={(e) => saveSettings({ enabled: e.target.checked })} data-testid="coach-enabled" /> {t("מופעל לעסק", "Enabled for the business")}</label>
          <span className="text-xs text-muted">{t("למידה מהקלטות: בלשונית \"למידה מעסקאות שנסגרו\"", "Learning from recordings: in the \"Learning from closed deals\" tab")}</span>
        </div>
        {providers && (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
            <span className="text-muted">{t("ספקים:", "Providers:")}</span>
            <span>{t("מודל AI", "AI model")} (ANTHROPIC_API_KEY) {keyBadge(providers.llm)}</span>
            <span>{t("תמלול חי", "Live transcription")} (OPENAI_API_KEY) {keyBadge(providers.stt)}</span>
            <span>{t("שליפה דומה", "Similarity retrieval")} {keyBadge(providers.embeddings)}</span>
          </div>
        )}
        <p className="text-[11px] text-muted mt-2">{t("ההמלצות מוצגות לנציג בלבד, אינן מוקראות ללקוח ואינן משנות את האודיו. תמלול והמלצות של עסק זה לעולם אינם נגישים לעסק אחר (סינון בשרת + RLS במסד).", "Suggestions are shown to the agent only; they are never read to the customer and never alter the audio. This business's transcripts and suggestions are never accessible to another business (server-side filtering + database RLS).")}</p>
      </Panel>

      <Panel title={t("נציגים", "Agents")}>
        <ul className="divide-y divide-line text-sm">
          {users.filter((u) => u.isActive).map((u) => (
            <li key={u.id} className="flex items-center justify-between py-1.5"><span>{u.fullName} <span className="text-xs text-muted">· {u.role === "owner" ? t("בעלים", "Owner") : u.role === "manager" ? t("מנהל", "Manager") : t("נציג", "Agent")}</span></span><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={u.coachEnabled} disabled={!isAdmin} onChange={(e) => toggleUser(u.id, e.target.checked)} /> {t("מאמן פעיל", "Coach active")}</label></li>
          ))}
        </ul>
      </Panel>

      <Panel title={t("ידע עסקי מאושר (המקור היחיד למחירים, תנאים ותכונות)", "Approved business knowledge (the only source for prices, terms and features)")} actions={<Button size="sm" onClick={saveKnowledge} data-testid="coach-knowledge-save">{t("שמור", "Save")}</Button>}>
        <div className="grid md:grid-cols-2 gap-3">
          <Textarea label={t("תיאור העסק", "Business description")} rows={2} value={k.description} onChange={(e) => setK({ ...k, description: e.target.value })} />
          <Textarea label={t("קהל היעד", "Target audience")} rows={2} value={k.audience} onChange={(e) => setK({ ...k, audience: e.target.value })} />
          <Textarea label={t("מוצרים ושירותים – שורה לכל מוצר: שם | מחיר | הערות", "Products & services – one per line: name | price | notes")} rows={4} value={text.products} onChange={(e) => setText({ ...text, products: e.target.value })} className="ltr-safe" />
          <Textarea label={t("יתרונות שאפשר לציין – שורה לכל יתרון", "Benefits to mention – one per line")} rows={4} value={text.benefits} onChange={(e) => setText({ ...text, benefits: e.target.value })} />
          <Textarea label={t("שאלות נפוצות – שאלה | תשובה", "FAQs – question | answer")} rows={4} value={text.faqs} onChange={(e) => setText({ ...text, faqs: e.target.value })} />
          <Textarea label={t("התנגדויות ותשובות מאושרות – התנגדות | תשובה", "Objections & approved responses – objection | response")} rows={4} value={text.objections} onChange={(e) => setText({ ...text, objections: e.target.value })} data-testid="coach-objections" />
          <Textarea label={t("טענות שאסור לומר – שורה לכל טענה", "Forbidden claims – one per line")} rows={3} value={text.forbidden} onChange={(e) => setText({ ...text, forbidden: e.target.value })} />
          <div className="space-y-2">
            <Input label={t("סגנון השיחה הרצוי", "Desired call style")} value={k.style} onChange={(e) => setK({ ...k, style: e.target.value })} />
            <Select label={t("מטרת השיחה", "Call goal")} value={k.callGoal} onChange={(e) => setK({ ...k, callGoal: e.target.value })}><option value="">{t("לא הוגדר", "Not set")}</option><option value="מכירה">{t("מכירה", "Sale")}</option><option value="תיאום פגישה">{t("תיאום פגישה", "Book a meeting")}</option><option value="חידוש לקוח">{t("חידוש לקוח", "Customer renewal")}</option><option value="בירור צרכים">{t("בירור צרכים", "Needs discovery")}</option></Select>
          </div>
        </div>
      </Panel>

      <Panel title={t("דוגמאות מכירה מהשיחות של העסק (לבדיקה ואישור)", "Sales examples from the business's calls (for review and approval)")} actions={<div className="flex gap-1">{(["pending", "approved", "rejected"] as const).map((s) => <button key={s} onClick={() => setExStatus(s)} className={cx("h-7 px-2 rounded-md text-xs", exStatus === s ? "bg-accent text-white" : "text-muted hover:text-text")}>{s === "pending" ? t("ממתינות", "Pending") : s === "approved" ? t("מאושרות", "Approved") : t("נפסלו", "Rejected")} ({counts[s] ?? 0})</button>)}</div>} bodyClassName="p-0">
        {!examples ? <div className="p-4"><Spinner /></div> : examples.length === 0 ? <p className="p-4 text-xs text-muted">{t("אין דוגמאות במצב זה. דוגמאות נוצרות אוטומטית משיחות שהמאמן תמלל, אחרי סיום השיחה.", "No examples in this state. Examples are created automatically from calls the coach transcribed, after the call ends.")}</p> : (
          <ul className="divide-y divide-line">
            {examples.map((ex) => (
              <li key={ex.id} className="p-3 text-sm space-y-1" data-testid="coach-example">
                <div className="flex flex-wrap items-center gap-2"><Badge tone={OUTCOME[ex.outcome][1]}>{t(OUTCOME[ex.outcome][0], OUTCOME[ex.outcome][2])}</Badge>{ex.stage && <span className="text-xs text-muted">{ex.stage}</span>}<span className="text-xs text-muted ms-auto tabular">{formatDateTime(ex.createdAt)}</span></div>
                <p><span className="text-muted">{t("התנגדות: ", "Objection: ")}</span>{ex.objection}</p>
                <p><span className="text-muted">{t("מה הנציג ענה: ", "Agent's response: ")}</span>{ex.editedResponse ?? ex.agentResponse}{ex.editedResponse && <span className="text-[11px] text-warn"> {t("(נערך)", "(edited)")}</span>}</p>
                {ex.quote && <blockquote className="text-xs text-muted whitespace-pre-wrap border-s-2 border-line ps-2">{ex.quote}</blockquote>}
                {exStatus !== "rejected" && (
                  <div className="flex flex-wrap items-end gap-2 pt-1">
                    <Input label={t("תשובה מתוקנת לשימוש עתידי (אופציונלי)", "Corrected response for future use (optional)")} value={edit[ex.id] ?? ""} onChange={(e) => setEdit({ ...edit, [ex.id]: e.target.value })} className="flex-1 min-w-64" />
                    {ex.status !== "approved" && <Button size="sm" onClick={() => review(ex, "approved")} data-testid="coach-example-approve">{t("אשר לשימוש", "Approve for use")}</Button>}
                    <Button size="sm" variant="ghost" onClick={() => review(ex, "rejected")}>{t("פסול", "Reject")}</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title={t("שימוש, המלצות ותוצאות (נמדד)", "Usage, suggestions and outcomes (measured)")} bodyClassName="p-0"><CoachReport /></Panel>
    </div>
  );
}
