"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { GraduationCap } from "lucide-react";
import { api } from "@/lib/client/api";
import { Badge, Button, Input, Modal, Select, Spinner, Textarea } from "@/components/ui";

interface Msg { id: string; direction: "INBOUND" | "OUTBOUND"; body: string | null; createdAt: string; aiBot?: boolean }
interface Draft { title: string; category: string; topic: string; question: string; answer: string; exampleQ: string; exampleA: string; whenToUse: string; limits: string; learnMode: "info" | "style" | "both" }
interface Analysis {
  draft: Draft; mode: "ai" | "basic"; statements: Array<{ type: string; text: string }>; caseSpecific: string[]; removedInstructions: number; redactions: string[];
  duplicates: Array<{ sourceId: string; title: string; excerpt: string }>; conflicts: Array<{ sourceId: string; title: string; detail: string }>; messageIds: string[];
}
const CATS: Record<string, string> = { business: "פרטי העסק ושעות פעילות", products: "מוצרים ושירותים", faq: "שאלות ותשובות", policy: "משלוחים, ביטולים והחזרות", guidelines: "הנחיות שירות ומכירה", docs: "מסמכים ומקורות" };
const PII: Record<string, string> = { name: "שמות", phone: "טלפונים", email: "אימיילים", payment: "פרטי תשלום", id: "מספרי זהות", order: "מספרי הזמנה", address: "כתובות", number: "מספרים מזהים" };
const STMT: Record<string, string> = { customer_claim: "טענת לקוח", agent_answer: "תשובת נציג", verified_solution: "פתרון שאומת", case_specific: "הבטחה/חריגה למקרה זה" };

/** "למד את ה-AI מהשיחה" – from the conversation menu. Anyone who may see the conversation can propose; managers publish. */
export function LearnFromConversation({ conversationId }: { conversationId: string }) {
  const [open, setOpen] = useState(false);
  const [learned, setLearned] = useState<Array<{ id: string; title: string; status: string }>>([]);
  useEffect(() => { api.get<{ items: typeof learned }>(`/api/ai/learn?conversationId=${conversationId}`).then((r) => setLearned(r.items)).catch(() => undefined); }, [conversationId, open]);
  return (
    <>
      {learned.length > 0 && <Badge tone="accent" className="text-[11px]" ><span data-testid="learned-mark" title={learned.map((l) => `${l.title} (${l.status === "approved" ? "מאושר" : l.status === "retired" ? "הוצא משימוש" : "טיוטה"})`).join("\n")}>🎓 הופק ממנה ידע ({learned.length})</span></Badge>}
      <Button size="sm" variant="ghost" icon={<GraduationCap size={15} />} onClick={() => setOpen(true)} data-testid="learn-open">למד את ה־AI מהשיחה</Button>
      {open && <LearnDialog conversationId={conversationId} onClose={() => setOpen(false)} />}
    </>
  );
}

function LearnDialog({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const [msgs, setMsgs] = useState<Msg[] | null>(null); const [sel, setSel] = useState<Set<string>>(new Set());
  const [instruction, setInstruction] = useState(""); const [busy, setBusy] = useState<string | null>(null);
  const [a, setA] = useState<Analysis | null>(null); const [d, setD] = useState<Draft | null>(null);
  const [supersedesId, setSupersedesId] = useState<string | null>(null); const [ack, setAck] = useState(false);
  const [canManage, setCanManage] = useState(false); const [connected, setConnected] = useState(true);
  const [testQ, setTestQ] = useState(""); const [test, setTest] = useState<{ answer: string | null; note?: string; sources: Array<{ title: string; kind: string; text: string }> } | null>(null);
  useEffect(() => {
    // This route returns plain JSON ({ messages }) – not the { data } envelope of the api client.
    fetch(`/api/conversations/${conversationId}/messages`, { cache: "no-store" }).then(async (res) => { const j = await res.json(); if (!res.ok) throw new Error(j.error ?? "טעינת ההודעות נכשלה"); const m = (j.messages as Msg[]).filter((x) => (x.body ?? "").trim()); setMsgs(m); setSel(new Set(m.map((x) => x.id))); }).catch((e) => toast.error((e as Error).message));
    api.get<{ canManage: boolean; connected: boolean }>("/api/ai").then((o) => { setCanManage(o.canManage); setConnected(o.connected); }).catch(() => undefined);
  }, [conversationId]);
  async function analyze() {
    setBusy("analyze");
    try { const r = await api.post<Analysis>("/api/ai/learn/analyze", { conversationId, messageIds: [...sel], instruction }); setA(r); setD(r.draft); setSupersedesId(null); setAck(false); setTest(null); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  async function save(publish: boolean) {
    if (!a || !d) return; setBusy(publish ? "publish" : "save");
    try {
      await api.post("/api/ai/learn", { conversationId, messageIds: a.messageIds, draft: d, publish, acknowledgeConflicts: ack, supersedesId });
      toast.success(publish ? "הידע אושר ופורסם לעוזר שירות הלקוחות" : "נשמר כטיוטה לבדיקת מנהל הידע"); onClose();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  async function runTest() {
    if (!d) return; setBusy("test");
    try { setTest(await api.post("/api/ai/learn/test", { draft: d, question: testQ })); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  const field = (k: keyof Draft, label: string, rows = 2) => <Textarea label={label} rows={rows} value={String(d?.[k] ?? "")} onChange={(e) => setD({ ...d!, [k]: e.target.value })} data-testid={`learn-${k}`} />;
  const blockingConflicts = Boolean(a?.conflicts.filter((c) => c.sourceId !== supersedesId).length) && !ack;
  return (
    <Modal open onClose={onClose} width="max-w-3xl" title="למד את ה־AI מהשיחה" footer={a ? <>
      <Button variant="ghost" onClick={() => { setA(null); setD(null); }}>חזרה לבחירת הודעות</Button>
      <Button variant="secondary" onClick={() => save(false)} loading={busy === "save"} data-testid="learn-save-draft">שמור כטיוטה לבדיקה</Button>
      {canManage && <Button onClick={() => save(true)} loading={busy === "publish"} disabled={blockingConflicts} data-testid="learn-publish">אשר ופרסם לשירות הלקוחות</Button>}
    </> : <><Button variant="ghost" onClick={onClose}>ביטול</Button><Button onClick={analyze} loading={busy === "analyze"} disabled={!sel.size} data-testid="learn-analyze">נתח והכן טיוטה</Button></>}>
      {!a ? (
        <div className="space-y-3" data-testid="learn-select">
          {!msgs ? <Spinner /> : <>
            <div className="flex items-center justify-between text-xs text-muted"><span>בחרו את ההודעות ללמידה ({sel.size}/{msgs.length})</span><span className="space-x-2 space-x-reverse"><button className="underline" onClick={() => setSel(new Set(msgs.map((m) => m.id)))}>כל השיחה</button><button className="underline" onClick={() => setSel(new Set())}>נקה</button></span></div>
            <div className="max-h-72 overflow-y-auto rounded-lg border border-line divide-y divide-line">
              {msgs.map((m) => <label key={m.id} className="flex gap-2 p-2 text-sm items-start" data-testid="learn-msg"><input type="checkbox" checked={sel.has(m.id)} onChange={(e) => { const s = new Set(sel); if (e.target.checked) s.add(m.id); else s.delete(m.id); setSel(s); }} /><Badge tone={m.direction === "INBOUND" ? "info" : "neutral"}>{m.direction === "INBOUND" ? "לקוח" : m.aiBot ? "בוט" : "נציג"}</Badge><span className="flex-1 whitespace-pre-wrap">{m.body}</span></label>)}
            </div>
          </>}
          <Textarea label="מה כדאי ללמוד מהשיחה הזאת? (אופציונלי)" rows={2} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="למשל: סגנון המענה, שאלות הבירור, או הדרך שבה נפתרה הבעיה" data-testid="learn-instruction" />
          <p className="text-xs text-muted">לפני הניתוח יוסרו שמות, טלפונים, כתובות, מספרי הזמנה ופרטי תשלום. {connected ? "" : "נדרש חיבור למודל AI לניתוח חכם – בלעדיו תיבנה טיוטה בסיסית מההודעות לעריכה ידנית."}</p>
        </div>
      ) : d && (
        <div className="space-y-3 text-sm" data-testid="learn-review">
          <div className="flex flex-wrap gap-2">
            <Badge tone={a.mode === "ai" ? "good" : "warn"}>{a.mode === "ai" ? "טיוטה שהוכנה על ידי AI" : "טיוטה בסיסית (ללא AI) – ערכו לפני שמירה"}</Badge>
            {a.redactions.length > 0 && <Badge tone="info" data-testid="learn-redactions">הוסרו: {a.redactions.map((r) => PII[r] ?? r).join(", ")}</Badge>}
            {a.removedInstructions > 0 && <Badge tone="bad">הוסרו {a.removedInstructions} הוראות שנכתבו בתוך השיחה</Badge>}
          </div>
          {a.caseSpecific.length > 0 && <div className="rounded-md border border-warn/40 bg-warn/10 p-2 text-xs" data-testid="learn-case-specific"><b>הבטחות / חריגות למקרה הספציפי – לא יהפכו למדיניות:</b><ul className="list-disc ps-5">{a.caseSpecific.map((c, i) => <li key={i}>{c}</li>)}</ul></div>}
          <div className="grid md:grid-cols-2 gap-3">
            <Input label="כותרת" value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} data-testid="learn-title" />
            <Select label="קטגוריה" value={d.category} onChange={(e) => setD({ ...d, category: e.target.value })}>{Object.entries(CATS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          </div>
          <div className="flex gap-4 text-sm" role="radiogroup" aria-label="מה ללמוד">
            {([["info", "מידע ותהליך שירות"], ["style", "סגנון מענה בלבד"], ["both", "שניהם"]] as const).map(([k, l]) => <label key={k} className="flex items-center gap-1"><input type="radio" checked={d.learnMode === k} onChange={() => setD({ ...d, learnMode: k })} data-testid={`learn-mode-${k}`} /> {l}</label>)}
          </div>
          {d.learnMode !== "style" && <>{field("question", "השאלה או הבעיה של הלקוח")}{field("answer", "התשובה או הפתרון (כללי – בלי הבטחות למקרה מסוים)", 3)}</>}
          <div className="grid md:grid-cols-2 gap-3">{field("exampleQ", "דוגמה – ניסוח הלקוח")}{field("exampleA", "דוגמה – ניסוח מוצלח של הנציג")}</div>
          {field("whenToUse", "באילו מצבים הידע מתאים")}
          {field("limits", "תנאים ומגבלות לשימוש")}
          {a.duplicates.length > 0 && <div className="rounded-md border border-line p-2 text-xs space-y-1" data-testid="learn-duplicates"><b>ידע קיים בנושא דומה:</b>
            <label className="flex items-center gap-1"><input type="radio" checked={!supersedesId} onChange={() => setSupersedesId(null)} /> ליצור פריט חדש</label>
            {a.duplicates.map((x) => <label key={x.sourceId} className="flex items-start gap-1"><input type="radio" checked={supersedesId === x.sourceId} onChange={() => setSupersedesId(x.sourceId)} data-testid="learn-supersede" /> <span>לעדכן את ״{x.title}״ (הישן יוצא משימוש באישור) – <span className="text-muted">{x.excerpt}</span></span></label>)}
          </div>}
          {a.conflicts.length > 0 && <div className="rounded-md border border-bad/40 bg-bad/10 p-2 text-xs" data-testid="learn-conflicts"><b>סתירה אפשרית מול ידע מאושר:</b><ul className="list-disc ps-5">{a.conflicts.map((c, i) => <li key={i}>{c.title}: {c.detail}</li>)}</ul>
            {canManage ? <label className="flex items-center gap-1 mt-1"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="learn-ack" /> בדקתי את הסתירה – אפשר לפרסם</label> : <p className="mt-1">הסתירה תוצג למנהל הידע לפני אישור.</p>}
          </div>}
          <details className="text-xs"><summary className="cursor-pointer text-muted">מה נאמר בשיחה ואיך סווג ({a.statements.length})</summary><ul className="mt-1 space-y-0.5">{a.statements.map((s, i) => <li key={i}><Badge tone={s.type === "case_specific" ? "warn" : s.type === "customer_claim" ? "info" : "neutral"}>{STMT[s.type] ?? s.type}</Badge> {s.text}</li>)}</ul></details>
          {canManage && <div className="rounded-md border border-line p-2 space-y-2" data-testid="learn-test">
            <div className="flex gap-2"><Input aria-label="שאלת בדיקה" className="flex-1" value={testQ} onChange={(e) => setTestQ(e.target.value)} placeholder="בדוק תשובה לדוגמה: הקלידו שאלה של לקוח" data-testid="learn-test-q" /><Button size="sm" variant="secondary" onClick={runTest} loading={busy === "test"} disabled={testQ.trim().length < 2} data-testid="learn-test-run">בדוק תשובה לדוגמה</Button></div>
            {test && <div className="text-xs space-y-1" data-testid="learn-test-result">{test.answer ? <p className="rounded bg-panel-2 p-2 text-sm whitespace-pre-wrap">{test.answer}</p> : <p className="text-warn">{test.note}</p>}<p className="text-muted">מקורות: {test.sources.map((s) => `${s.title} (${s.kind === "policy" ? "מדיניות" : s.kind === "style" ? "סגנון" : "דוגמה"})`).join(" · ")}</p><p className="text-muted">הבדיקה לא שומרת, לא מפרסמת ולא שולחת דבר ללקוח.</p></div>}
          </div>}
        </div>
      )}
    </Modal>
  );
}
