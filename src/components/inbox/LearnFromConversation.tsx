"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { GraduationCap } from "lucide-react";
import { api } from "@/lib/client/api";
import { Badge, Button, Input, Modal, Select, Spinner, Textarea } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

interface Msg { id: string; direction: "INBOUND" | "OUTBOUND"; body: string | null; createdAt: string; aiBot?: boolean }
interface Draft { title: string; category: string; topic: string; question: string; answer: string; exampleQ: string; exampleA: string; whenToUse: string; limits: string; learnMode: "info" | "style" | "both" }
interface Analysis {
  draft: Draft; mode: "ai" | "basic"; statements: Array<{ type: string; text: string }>; caseSpecific: string[]; removedInstructions: number; redactions: string[];
  duplicates: Array<{ sourceId: string; title: string; excerpt: string }>; conflicts: Array<{ sourceId: string; title: string; detail: string }>; messageIds: string[];
}
const CATS: Record<string, [string, string]> = { business: ["פרטי העסק ושעות פעילות", "Business details & hours"], products: ["מוצרים ושירותים", "Products & services"], faq: ["שאלות ותשובות", "FAQ"], policy: ["משלוחים, ביטולים והחזרות", "Shipping, cancellations & returns"], guidelines: ["הנחיות שירות ומכירה", "Service & sales guidelines"], docs: ["מסמכים ומקורות", "Documents & sources"] };
const PII: Record<string, [string, string]> = { name: ["שמות", "names"], phone: ["טלפונים", "phone numbers"], email: ["אימיילים", "emails"], payment: ["פרטי תשלום", "payment details"], id: ["מספרי זהות", "ID numbers"], order: ["מספרי הזמנה", "order numbers"], address: ["כתובות", "addresses"], number: ["מספרים מזהים", "identifying numbers"] };
const STMT: Record<string, [string, string]> = { customer_claim: ["טענת לקוח", "Customer claim"], agent_answer: ["תשובת נציג", "Agent answer"], verified_solution: ["פתרון שאומת", "Verified solution"], case_specific: ["הבטחה/חריגה למקרה זה", "Case-specific promise/exception"] };

/** "למד את ה-AI מהשיחה" – from the conversation menu. Anyone who may see the conversation can propose; managers publish. */
export function LearnFromConversation({ conversationId }: { conversationId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [learned, setLearned] = useState<Array<{ id: string; title: string; status: string }>>([]);
  useEffect(() => { api.get<{ items: typeof learned }>(`/api/ai/learn?conversationId=${conversationId}`).then((r) => setLearned(r.items)).catch(() => undefined); }, [conversationId, open]);
  return (
    <>
      {learned.length > 0 && <Badge tone="accent" className="text-[11px]" ><span data-testid="learned-mark" title={learned.map((l) => `${l.title} (${l.status === "approved" ? t("מאושר", "approved") : l.status === "retired" ? t("הוצא משימוש", "retired") : t("טיוטה", "draft")})`).join("\n")}>{t(`🎓 הופק ממנה ידע (${learned.length})`, `🎓 Knowledge extracted (${learned.length})`)}</span></Badge>}
      <Button size="sm" variant="ghost" icon={<GraduationCap size={15} />} onClick={() => setOpen(true)} data-testid="learn-open">{t("למד את ה־AI מהשיחה", "Teach the AI from this conversation")}</Button>
      {open && <LearnDialog conversationId={conversationId} onClose={() => setOpen(false)} />}
    </>
  );
}

function LearnDialog({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const t = useT();
  const [msgs, setMsgs] = useState<Msg[] | null>(null); const [sel, setSel] = useState<Set<string>>(new Set());
  const [instruction, setInstruction] = useState(""); const [busy, setBusy] = useState<string | null>(null);
  const [a, setA] = useState<Analysis | null>(null); const [d, setD] = useState<Draft | null>(null);
  const [supersedesId, setSupersedesId] = useState<string | null>(null); const [ack, setAck] = useState(false);
  const [canManage, setCanManage] = useState(false); const [connected, setConnected] = useState(true);
  const [testQ, setTestQ] = useState(""); const [test, setTest] = useState<{ answer: string | null; note?: string; sources: Array<{ title: string; kind: string; text: string }> } | null>(null);
  useEffect(() => {
    // This route returns plain JSON ({ messages }) – not the { data } envelope of the api client.
    fetch(`/api/conversations/${conversationId}/messages`, { cache: "no-store" }).then(async (res) => { const j = await res.json(); if (!res.ok) throw new Error(j.error ?? t("טעינת ההודעות נכשלה", "Failed to load messages")); const m = (j.messages as Msg[]).filter((x) => (x.body ?? "").trim()); setMsgs(m); setSel(new Set(m.map((x) => x.id))); }).catch((e) => toast.error((e as Error).message));
    api.get<{ canManage: boolean; connected: boolean }>("/api/ai").then((o) => { setCanManage(o.canManage); setConnected(o.connected); }).catch(() => undefined);
  }, [conversationId, t]);
  async function analyze() {
    setBusy("analyze");
    try { const r = await api.post<Analysis>("/api/ai/learn/analyze", { conversationId, messageIds: [...sel], instruction }); setA(r); setD(r.draft); setSupersedesId(null); setAck(false); setTest(null); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  async function save(publish: boolean) {
    if (!a || !d) return; setBusy(publish ? "publish" : "save");
    try {
      await api.post("/api/ai/learn", { conversationId, messageIds: a.messageIds, draft: d, publish, acknowledgeConflicts: ack, supersedesId });
      toast.success(publish ? t("הידע אושר ופורסם לעוזר שירות הלקוחות", "Knowledge approved and published to the customer service assistant") : t("נשמר כטיוטה לבדיקת מנהל הידע", "Saved as a draft for the knowledge manager to review")); onClose();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  async function runTest() {
    if (!d) return; setBusy("test");
    try { setTest(await api.post("/api/ai/learn/test", { draft: d, question: testQ })); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  const field = (k: keyof Draft, label: string, rows = 2) => <Textarea label={label} rows={rows} value={String(d?.[k] ?? "")} onChange={(e) => setD({ ...d!, [k]: e.target.value })} data-testid={`learn-${k}`} />;
  const blockingConflicts = Boolean(a?.conflicts.filter((c) => c.sourceId !== supersedesId).length) && !ack;
  return (
    <Modal open onClose={onClose} width="max-w-3xl" title={t("למד את ה־AI מהשיחה", "Teach the AI from this conversation")} footer={a ? <>
      <Button variant="ghost" onClick={() => { setA(null); setD(null); }}>{t("חזרה לבחירת הודעות", "Back to message selection")}</Button>
      <Button variant="secondary" onClick={() => save(false)} loading={busy === "save"} data-testid="learn-save-draft">{t("שמור כטיוטה לבדיקה", "Save as draft for review")}</Button>
      {canManage && <Button onClick={() => save(true)} loading={busy === "publish"} disabled={blockingConflicts} data-testid="learn-publish">{t("אשר ופרסם לשירות הלקוחות", "Approve & publish to customer service")}</Button>}
    </> : <><Button variant="ghost" onClick={onClose}>{t("ביטול", "Cancel")}</Button><Button onClick={analyze} loading={busy === "analyze"} disabled={!sel.size} data-testid="learn-analyze">{t("נתח והכן טיוטה", "Analyze & prepare draft")}</Button></>}>
      {!a ? (
        <div className="space-y-3" data-testid="learn-select">
          {!msgs ? <Spinner /> : <>
            <div className="flex items-center justify-between text-xs text-muted"><span>{t(`בחרו את ההודעות ללמידה (${sel.size}/${msgs.length})`, `Select messages to learn from (${sel.size}/${msgs.length})`)}</span><span className="space-x-2 space-x-reverse"><button className="underline" onClick={() => setSel(new Set(msgs.map((m) => m.id)))}>{t("כל השיחה", "Whole conversation")}</button><button className="underline" onClick={() => setSel(new Set())}>{t("נקה", "Clear")}</button></span></div>
            <div className="max-h-72 overflow-y-auto rounded-lg border border-line divide-y divide-line">
              {msgs.map((m) => <label key={m.id} className="flex gap-2 p-2 text-sm items-start" data-testid="learn-msg"><input type="checkbox" checked={sel.has(m.id)} onChange={(e) => { const s = new Set(sel); if (e.target.checked) s.add(m.id); else s.delete(m.id); setSel(s); }} /><Badge tone={m.direction === "INBOUND" ? "info" : "neutral"}>{m.direction === "INBOUND" ? t("לקוח", "Customer") : m.aiBot ? t("בוט", "Bot") : t("נציג", "Agent")}</Badge><span className="flex-1 whitespace-pre-wrap">{m.body}</span></label>)}
            </div>
          </>}
          <Textarea label={t("מה כדאי ללמוד מהשיחה הזאת? (אופציונלי)", "What should be learned from this conversation? (optional)")} rows={2} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder={t("למשל: סגנון המענה, שאלות הבירור, או הדרך שבה נפתרה הבעיה", "e.g. the reply style, the clarifying questions, or how the issue was resolved")} data-testid="learn-instruction" />
          <p className="text-xs text-muted">{t("לפני הניתוח יוסרו שמות, טלפונים, כתובות, מספרי הזמנה ופרטי תשלום.", "Names, phone numbers, addresses, order numbers and payment details are removed before analysis.")} {connected ? "" : t("נדרש חיבור למודל AI לניתוח חכם – בלעדיו תיבנה טיוטה בסיסית מההודעות לעריכה ידנית.", "Smart analysis requires a connected AI model – without it, a basic draft is built from the messages for manual editing.")}</p>
        </div>
      ) : d && (
        <div className="space-y-3 text-sm" data-testid="learn-review">
          <div className="flex flex-wrap gap-2">
            <Badge tone={a.mode === "ai" ? "good" : "warn"}>{a.mode === "ai" ? t("טיוטה שהוכנה על ידי AI", "AI-prepared draft") : t("טיוטה בסיסית (ללא AI) – ערכו לפני שמירה", "Basic draft (no AI) – edit before saving")}</Badge>
            {a.redactions.length > 0 && <Badge tone="info" data-testid="learn-redactions">{t("הוסרו:", "Removed:")} {a.redactions.map((r) => (PII[r] ? t(PII[r][0], PII[r][1]) : r)).join(", ")}</Badge>}
            {a.removedInstructions > 0 && <Badge tone="bad">{t(`הוסרו ${a.removedInstructions} הוראות שנכתבו בתוך השיחה`, `Removed ${a.removedInstructions} instructions written inside the conversation`)}</Badge>}
          </div>
          {a.caseSpecific.length > 0 && <div className="rounded-md border border-warn/40 bg-warn/10 p-2 text-xs" data-testid="learn-case-specific"><b>{t("הבטחות / חריגות למקרה הספציפי – לא יהפכו למדיניות:", "Case-specific promises / exceptions – will not become policy:")}</b><ul className="list-disc ps-5">{a.caseSpecific.map((c, i) => <li key={i}>{c}</li>)}</ul></div>}
          <div className="grid md:grid-cols-2 gap-3">
            <Input label={t("כותרת", "Title")} value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} data-testid="learn-title" />
            <Select label={t("קטגוריה", "Category")} value={d.category} onChange={(e) => setD({ ...d, category: e.target.value })}>{Object.entries(CATS).map(([k, v]) => <option key={k} value={k}>{t(v[0], v[1])}</option>)}</Select>
          </div>
          <div className="flex gap-4 text-sm" role="radiogroup" aria-label={t("מה ללמוד", "What to learn")}>
            {([["info", "מידע ותהליך שירות", "Information & service process"], ["style", "סגנון מענה בלבד", "Reply style only"], ["both", "שניהם", "Both"]] as const).map(([k, lHe, lEn]) => <label key={k} className="flex items-center gap-1"><input type="radio" checked={d.learnMode === k} onChange={() => setD({ ...d, learnMode: k })} data-testid={`learn-mode-${k}`} /> {t(lHe, lEn)}</label>)}
          </div>
          {d.learnMode !== "style" && <>{field("question", t("השאלה או הבעיה של הלקוח", "The customer's question or issue"))}{field("answer", t("התשובה או הפתרון (כללי – בלי הבטחות למקרה מסוים)", "The answer or solution (general – no case-specific promises)"), 3)}</>}
          <div className="grid md:grid-cols-2 gap-3">{field("exampleQ", t("דוגמה – ניסוח הלקוח", "Example – customer wording"))}{field("exampleA", t("דוגמה – ניסוח מוצלח של הנציג", "Example – a good agent reply"))}</div>
          {field("whenToUse", t("באילו מצבים הידע מתאים", "When this knowledge applies"))}
          {field("limits", t("תנאים ומגבלות לשימוש", "Conditions & limitations"))}
          {a.duplicates.length > 0 && <div className="rounded-md border border-line p-2 text-xs space-y-1" data-testid="learn-duplicates"><b>{t("ידע קיים בנושא דומה:", "Existing knowledge on a similar topic:")}</b>
            <label className="flex items-center gap-1"><input type="radio" checked={!supersedesId} onChange={() => setSupersedesId(null)} /> {t("ליצור פריט חדש", "Create a new item")}</label>
            {a.duplicates.map((x) => <label key={x.sourceId} className="flex items-start gap-1"><input type="radio" checked={supersedesId === x.sourceId} onChange={() => setSupersedesId(x.sourceId)} data-testid="learn-supersede" /> <span>{t(`לעדכן את ״${x.title}״ (הישן יוצא משימוש באישור)`, `Update “${x.title}” (the old one is retired on approval)`)} – <span className="text-muted">{x.excerpt}</span></span></label>)}
          </div>}
          {a.conflicts.length > 0 && <div className="rounded-md border border-bad/40 bg-bad/10 p-2 text-xs" data-testid="learn-conflicts"><b>{t("סתירה אפשרית מול ידע מאושר:", "Possible conflict with approved knowledge:")}</b><ul className="list-disc ps-5">{a.conflicts.map((c, i) => <li key={i}>{c.title}: {c.detail}</li>)}</ul>
            {canManage ? <label className="flex items-center gap-1 mt-1"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="learn-ack" /> {t("בדקתי את הסתירה – אפשר לפרסם", "I reviewed the conflict – OK to publish")}</label> : <p className="mt-1">{t("הסתירה תוצג למנהל הידע לפני אישור.", "The conflict will be shown to the knowledge manager before approval.")}</p>}
          </div>}
          <details className="text-xs"><summary className="cursor-pointer text-muted">{t(`מה נאמר בשיחה ואיך סווג (${a.statements.length})`, `What was said and how it was classified (${a.statements.length})`)}</summary><ul className="mt-1 space-y-0.5">{a.statements.map((s, i) => <li key={i}><Badge tone={s.type === "case_specific" ? "warn" : s.type === "customer_claim" ? "info" : "neutral"}>{STMT[s.type] ? t(STMT[s.type][0], STMT[s.type][1]) : s.type}</Badge> {s.text}</li>)}</ul></details>
          {canManage && <div className="rounded-md border border-line p-2 space-y-2" data-testid="learn-test">
            <div className="flex gap-2"><Input aria-label={t("שאלת בדיקה", "Test question")} className="flex-1" value={testQ} onChange={(e) => setTestQ(e.target.value)} placeholder={t("בדוק תשובה לדוגמה: הקלידו שאלה של לקוח", "Test a sample answer: type a customer question")} data-testid="learn-test-q" /><Button size="sm" variant="secondary" onClick={runTest} loading={busy === "test"} disabled={testQ.trim().length < 2} data-testid="learn-test-run">{t("בדוק תשובה לדוגמה", "Test sample answer")}</Button></div>
            {test && <div className="text-xs space-y-1" data-testid="learn-test-result">{test.answer ? <p className="rounded bg-panel-2 p-2 text-sm whitespace-pre-wrap">{test.answer}</p> : <p className="text-warn">{test.note}</p>}<p className="text-muted">{t("מקורות:", "Sources:")} {test.sources.map((s) => `${s.title} (${s.kind === "policy" ? t("מדיניות", "policy") : s.kind === "style" ? t("סגנון", "style") : t("דוגמה", "example")})`).join(" · ")}</p><p className="text-muted">{t("הבדיקה לא שומרת, לא מפרסמת ולא שולחת דבר ללקוח.", "Testing doesn't save, publish or send anything to the customer.")}</p></div>}
          </div>}
        </div>
      )}
    </Modal>
  );
}
