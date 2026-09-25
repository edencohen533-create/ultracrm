"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Input, Panel, Select, Spinner, Textarea, cx } from "@/components/ui";
import { formatDateTime } from "@/lib/client/format";
import { CoachReport } from "./CoachReport";

type Knowledge = { description: string; audience: string; products: Array<{ name: string; price?: string; notes?: string }>; benefits: string[]; faqs: Array<{ question: string; answer: string }>; objections: Array<{ objection: string; response: string }>; forbiddenClaims: string[]; style: string; callGoal: string };
type Example = { id: string; callId: string | null; objection: string; agentResponse: string; editedResponse: string | null; stage: string | null; outcome: "won" | "lost" | "unknown"; quote: string; status: "pending" | "approved" | "rejected"; createdAt: string };
type Providers = { llm: string; stt: string; embeddings: string; mock: boolean };

const linesToPairs = (text: string, sep = "|") => text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [a, ...rest] = l.split(sep); return [a.trim(), rest.join(sep).trim()] as [string, string]; });
const OUTCOME = { won: ["נסגרה", "good"], lost: ["לא נסגרה", "bad"], unknown: ["ללא תוצאה", "neutral"] } as const;

/** Manager settings for the coach: on/off (business + per agent), approved knowledge, example review, provider status. */
export function CoachAdmin({ isAdmin }: { isAdmin: boolean }) {
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
    try { await api.patch("/api/settings", { settings: { coach: next } }); toast.success("נשמר"); } catch (e) { toast.error((e as Error).message); }
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
    try { await api.put("/api/coach/knowledge", body); toast.success("הידע העסקי נשמר"); } catch (e) { toast.error((e as Error).message); }
  }
  async function review(ex: Example, status: "approved" | "rejected") {
    try { await api.patch(`/api/coach/examples/${ex.id}`, { status, editedResponse: edit[ex.id] !== undefined ? (edit[ex.id] || null) : undefined }); toast.success(status === "approved" ? "אושר לשימוש" : "נפסל"); loadExamples(); } catch (e) { toast.error((e as Error).message); }
  }

  if (!settings || !k) return <Spinner />;
  const keyBadge = (v: string) => v === "missing" ? <Badge tone="bad">חסר</Badge> : v === "mock" ? <Badge tone="warn">מדומה</Badge> : v === "keyword" ? <Badge tone="neutral">מילות מפתח</Badge> : <Badge tone="good">{v}</Badge>;
  return (
    <div className="space-y-4">
      <Panel title="מאמן מכירות בזמן אמת">
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={settings.enabled} disabled={!isAdmin} onChange={(e) => saveSettings({ enabled: e.target.checked })} data-testid="coach-enabled" /> מופעל לעסק</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={settings.learnFromRecordings} disabled={!isAdmin} onChange={(e) => saveSettings({ learnFromRecordings: e.target.checked })} /> ללמוד גם מהקלטות שמורות (עלות תמלול)</label>
        </div>
        {providers && (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
            <span className="text-muted">ספקים:</span>
            <span>מודל AI (ANTHROPIC_API_KEY) {keyBadge(providers.llm)}</span>
            <span>תמלול חי (OPENAI_API_KEY) {keyBadge(providers.stt)}</span>
            <span>שליפה דומה {keyBadge(providers.embeddings)}</span>
          </div>
        )}
        <p className="text-[11px] text-muted mt-2">ההמלצות מוצגות לנציג בלבד, אינן מוקראות ללקוח ואינן משנות את האודיו. תמלול והמלצות של עסק זה לעולם אינם נגישים לעסק אחר (סינון בשרת + RLS במסד).</p>
      </Panel>

      <Panel title="נציגים">
        <ul className="divide-y divide-line text-sm">
          {users.filter((u) => u.isActive).map((u) => (
            <li key={u.id} className="flex items-center justify-between py-1.5"><span>{u.fullName} <span className="text-xs text-muted">· {u.role === "owner" ? "בעלים" : u.role === "manager" ? "מנהל" : "נציג"}</span></span><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={u.coachEnabled} disabled={!isAdmin} onChange={(e) => toggleUser(u.id, e.target.checked)} /> מאמן פעיל</label></li>
          ))}
        </ul>
      </Panel>

      <Panel title="ידע עסקי מאושר (המקור היחיד למחירים, תנאים ותכונות)" actions={<Button size="sm" onClick={saveKnowledge} data-testid="coach-knowledge-save">שמור</Button>}>
        <div className="grid md:grid-cols-2 gap-3">
          <Textarea label="תיאור העסק" rows={2} value={k.description} onChange={(e) => setK({ ...k, description: e.target.value })} />
          <Textarea label="קהל היעד" rows={2} value={k.audience} onChange={(e) => setK({ ...k, audience: e.target.value })} />
          <Textarea label="מוצרים ושירותים – שורה לכל מוצר: שם | מחיר | הערות" rows={4} value={text.products} onChange={(e) => setText({ ...text, products: e.target.value })} className="ltr-safe" />
          <Textarea label="יתרונות שאפשר לציין – שורה לכל יתרון" rows={4} value={text.benefits} onChange={(e) => setText({ ...text, benefits: e.target.value })} />
          <Textarea label="שאלות נפוצות – שאלה | תשובה" rows={4} value={text.faqs} onChange={(e) => setText({ ...text, faqs: e.target.value })} />
          <Textarea label="התנגדויות ותשובות מאושרות – התנגדות | תשובה" rows={4} value={text.objections} onChange={(e) => setText({ ...text, objections: e.target.value })} data-testid="coach-objections" />
          <Textarea label="טענות שאסור לומר – שורה לכל טענה" rows={3} value={text.forbidden} onChange={(e) => setText({ ...text, forbidden: e.target.value })} />
          <div className="space-y-2">
            <Input label="סגנון השיחה הרצוי" value={k.style} onChange={(e) => setK({ ...k, style: e.target.value })} />
            <Select label="מטרת השיחה" value={k.callGoal} onChange={(e) => setK({ ...k, callGoal: e.target.value })}><option value="">לא הוגדר</option><option value="מכירה">מכירה</option><option value="תיאום פגישה">תיאום פגישה</option><option value="חידוש לקוח">חידוש לקוח</option><option value="בירור צרכים">בירור צרכים</option></Select>
          </div>
        </div>
      </Panel>

      <Panel title="דוגמאות מכירה מהשיחות של העסק (לבדיקה ואישור)" actions={<div className="flex gap-1">{(["pending", "approved", "rejected"] as const).map((s) => <button key={s} onClick={() => setExStatus(s)} className={cx("h-7 px-2 rounded-md text-xs", exStatus === s ? "bg-accent text-white" : "text-muted hover:text-text")}>{s === "pending" ? "ממתינות" : s === "approved" ? "מאושרות" : "נפסלו"} ({counts[s] ?? 0})</button>)}</div>} bodyClassName="p-0">
        {!examples ? <div className="p-4"><Spinner /></div> : examples.length === 0 ? <p className="p-4 text-xs text-muted">אין דוגמאות במצב זה. דוגמאות נוצרות אוטומטית משיחות שהמאמן תמלל, אחרי סיום השיחה.</p> : (
          <ul className="divide-y divide-line">
            {examples.map((ex) => (
              <li key={ex.id} className="p-3 text-sm space-y-1" data-testid="coach-example">
                <div className="flex flex-wrap items-center gap-2"><Badge tone={OUTCOME[ex.outcome][1]}>{OUTCOME[ex.outcome][0]}</Badge>{ex.stage && <span className="text-xs text-muted">{ex.stage}</span>}<span className="text-xs text-muted ms-auto tabular">{formatDateTime(ex.createdAt)}</span></div>
                <p><span className="text-muted">התנגדות: </span>{ex.objection}</p>
                <p><span className="text-muted">מה הנציג ענה: </span>{ex.editedResponse ?? ex.agentResponse}{ex.editedResponse && <span className="text-[11px] text-warn"> (נערך)</span>}</p>
                {ex.quote && <blockquote className="text-xs text-muted whitespace-pre-wrap border-s-2 border-line ps-2">{ex.quote}</blockquote>}
                {exStatus !== "rejected" && (
                  <div className="flex flex-wrap items-end gap-2 pt-1">
                    <Input label="תשובה מתוקנת לשימוש עתידי (אופציונלי)" value={edit[ex.id] ?? ""} onChange={(e) => setEdit({ ...edit, [ex.id]: e.target.value })} className="flex-1 min-w-64" />
                    {ex.status !== "approved" && <Button size="sm" onClick={() => review(ex, "approved")} data-testid="coach-example-approve">אשר לשימוש</Button>}
                    <Button size="sm" variant="ghost" onClick={() => review(ex, "rejected")}>פסול</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="שימוש, המלצות ותוצאות (נמדד)" bodyClassName="p-0"><CoachReport /></Panel>
    </div>
  );
}
