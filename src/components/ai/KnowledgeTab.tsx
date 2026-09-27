"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, EmptyState, Input, Modal, Panel, Select, Spinner, Textarea } from "@/components/ui";

interface Source { id: string; title: string; category: string; kind: "text" | "file" | "link" | "conversation"; audience: "internal" | "customer"; status: "draft" | "approved" | "retired"; learnMode?: "info" | "style" | "both" | null; sourceConversationId?: string | null; conflicts?: Array<{ title: string; detail: string }> | null; proposedBy?: string | null; approvedBy?: string | null; processing: "pending" | "processing" | "ready" | "failed"; error: string | null; url: string | null; fileName: string | null; chunks: number; updatedAt: string }
const PROC: Record<Source["processing"], { l: string; t: "neutral" | "warn" | "good" | "bad" }> = { pending: { l: "ממתין", t: "neutral" }, processing: { l: "בעיבוד", t: "warn" }, ready: { l: "מוכן", t: "good" }, failed: { l: "נכשל", t: "bad" } };
const KIND: Record<Source["kind"], string> = { text: "טקסט", file: "קובץ", link: "קישור", conversation: "נלמד משיחה" };
const MODE: Record<string, string> = { info: "מידע ותהליך", style: "סגנון בלבד", both: "מידע + סגנון" };

export function KnowledgeTab() {
  const [items, setItems] = useState<Source[] | null>(null); const [cats, setCats] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false); const [testOpen, setTestOpen] = useState(false); const [filter, setFilter] = useState("");
  const load = useCallback(async () => { try { const r = await api.get<{ items: Source[]; categories: Record<string, string> }>("/api/ai/knowledge"); setItems(r.items); setCats(r.categories); } catch (e) { toast.error((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);
  async function patch(s: Source, body: Record<string, unknown>) { try { await api.patch(`/api/ai/knowledge/${s.id}`, body); await load(); } catch (e) { toast.error((e as Error).message); } }
  async function remove(s: Source) { if (!confirm(`למחוק את "${s.title}"? הוא יוסר מיד מהתשובות.`)) return; try { await api.delete(`/api/ai/knowledge/${s.id}`); await load(); } catch (e) { toast.error((e as Error).message); } }
  async function retry(s: Source) { try { await api.post(`/api/ai/knowledge/${s.id}/retry`); await load(); } catch (e) { toast.error((e as Error).message); } }
  if (!items) return <div className="py-10 flex justify-center"><Spinner /></div>;
  const shown = items.filter((s) => !filter || s.category === filter);
  return (
    <div className="space-y-4" data-testid="ai-knowledge">
      <div className="flex flex-wrap gap-2 items-center">
        <Button onClick={() => setAdding(true)} data-testid="kb-add">הוספת ידע</Button>
        <Button variant="secondary" onClick={() => setTestOpen(true)} data-testid="kb-test-open">בדוק את העוזר</Button>
        <Select aria-label="סינון קטגוריה" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-56"><option value="">כל הקטגוריות</option>{Object.entries(cats).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
      </div>
      <p className="text-xs text-muted">ידע חדש נשמר כ<b>טיוטה</b> ו<b>פנימי בלבד</b>. העוזר משתמש רק בידע מאושר, ונציג השירות ללקוחות – רק בידע מאושר שסומן &quot;מותר מול לקוחות&quot;. נתונים חיים (מחיר עדכני, מלאי, סטטוס הזמנה) לא נלקחים מכאן.</p>
      {!shown.length ? <EmptyState title="עדיין אין ידע" hint="הוסיפו שעות פעילות, מדיניות משלוחים והחזרות, שאלות נפוצות ומסמכים" /> :
        <Panel bodyClassName="p-0"><table className="w-full text-sm"><thead className="text-xs text-muted"><tr><th className="text-start p-2">כותרת</th><th className="text-start">קטגוריה</th><th className="text-start">סוג</th><th className="text-start">עיבוד</th><th className="text-start">קהל</th><th className="text-start">סטטוס</th><th /></tr></thead>
          <tbody className="divide-y divide-line">{shown.map((s) => <tr key={s.id} data-testid="kb-row">
            <td className="p-2"><div className="font-medium">{s.title}</div>{s.kind === "conversation" && <div className="text-xs text-muted" data-testid="kb-learned-meta">{s.learnMode ? MODE[s.learnMode] : ""}{s.proposedBy ? ` · הציע: ${s.proposedBy}` : ""}{s.approvedBy ? ` · אישר: ${s.approvedBy}` : ""}{s.sourceConversationId && <> · <a className="underline" href={`/inbox/${s.sourceConversationId}`}>שיחת המקור</a></>}</div>}{s.conflicts?.length ? <div className="text-xs text-bad" data-testid="kb-conflict">סתירה אפשרית: {s.conflicts.map((c) => `${c.title} – ${c.detail}`).join("; ")}</div> : null}{s.url && <div className="text-xs text-muted ltr text-start truncate max-w-xs">{s.url}</div>}{s.fileName && <div className="text-xs text-muted">{s.fileName}</div>}</td>
            <td className="text-muted">{cats[s.category] ?? s.category}</td><td>{KIND[s.kind]}</td>
            <td><Badge tone={PROC[s.processing].t}>{PROC[s.processing].l}{s.processing === "ready" ? ` · ${s.chunks}` : ""}</Badge>{s.error && <div className="text-xs text-bad max-w-[200px]">{s.error}</div>}</td>
            <td><Select aria-label="קהל" value={s.audience} onChange={(e) => patch(s, { audience: e.target.value })} className="w-40"><option value="internal">פנימי בלבד</option><option value="customer">מותר מול לקוחות</option></Select></td>
            <td>{s.status === "approved" ? <Badge tone="good">מאושר</Badge> : s.status === "retired" ? <Badge tone="neutral">הוצא משימוש</Badge> : <Badge>טיוטה</Badge>}</td>
            <td className="whitespace-nowrap space-x-1 space-x-reverse p-2">
              {s.status !== "approved" ? <Button size="sm" disabled={s.processing !== "ready"} onClick={() => { if (s.conflicts?.length && !confirm(`יש סתירה אפשרית מול ידע מאושר:\n${s.conflicts.map((c) => `${c.title} – ${c.detail}`).join("\n")}\n\nלאשר בכל זאת?`)) return; void patch(s, { status: "approved", acknowledgeConflicts: Boolean(s.conflicts?.length) }); }} data-testid="kb-approve">אשר</Button> : <><Button size="sm" variant="ghost" onClick={() => patch(s, { status: "draft" })}>החזר לטיוטה</Button><Button size="sm" variant="ghost" onClick={() => patch(s, { status: "retired" })} data-testid="kb-retire">הוצא משימוש</Button></>}
              {s.processing === "failed" && <Button size="sm" variant="secondary" onClick={() => retry(s)} data-testid="kb-retry">נסה שוב</Button>}
              <Button size="sm" variant="ghost" onClick={() => remove(s)}>מחק</Button>
            </td></tr>)}</tbody></table></Panel>}
      {adding && <AddSource cats={cats} onClose={() => setAdding(false)} onDone={() => { setAdding(false); void load(); }} />}
      {testOpen && <TestAssistant onClose={() => setTestOpen(false)} />}
    </div>
  );
}

function AddSource({ cats, onClose, onDone }: { cats: Record<string, string>; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<"text" | "file" | "link">("text"); const [title, setTitle] = useState(""); const [category, setCategory] = useState("faq");
  const [content, setContent] = useState(""); const [url, setUrl] = useState(""); const [file, setFile] = useState<File | null>(null); const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      let r: { processing: string; error: string | null };
      if (kind === "file") {
        if (!file) throw new Error("בחרו קובץ");
        const fd = new FormData(); fd.set("file", file); fd.set("title", title || file.name); fd.set("category", category);
        const res = await fetch("/api/ai/knowledge", { method: "POST", body: fd }); const j = await res.json();
        if (!res.ok || j.success === false) throw new Error(j.error ?? "ההעלאה נכשלה"); r = j.data;
      } else r = await api.post("/api/ai/knowledge", { kind, title, category, ...(kind === "text" ? { content } : { url }) });
      if (r.processing === "failed") toast.error(`נשמר, אך העיבוד נכשל: ${r.error}`); else toast.success("נשמר כטיוטה – אשרו כדי שהעוזר ישתמש בו");
      onDone();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title="הוספת ידע" footer={<><Button variant="ghost" onClick={onClose}>ביטול</Button><Button onClick={save} loading={busy} data-testid="kb-save">שמור</Button></>}>
      <div className="space-y-3">
        <div className="flex gap-2">{(["text", "file", "link"] as const).map((k) => <Button key={k} size="sm" variant={kind === k ? "primary" : "secondary"} onClick={() => setKind(k)}>{KIND[k]}</Button>)}</div>
        <Input label="כותרת" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="kb-title" />
        <Select label="קטגוריה" value={category} onChange={(e) => setCategory(e.target.value)}>{Object.entries(cats).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        {kind === "text" && <Textarea label="תוכן" rows={8} value={content} onChange={(e) => setContent(e.target.value)} data-testid="kb-content" />}
        {kind === "link" && <Input label="קישור (https ציבורי בלבד)" ltr value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />}
        {kind === "file" && <div><input type="file" accept=".pdf,.txt,.md,.csv,.html,.htm,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /><p className="text-xs text-muted mt-1">PDF, TXT, MD, CSV, HTML עד 5MB</p></div>}
      </div>
    </Modal>
  );
}

function TestAssistant({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState(""); const [audience, setAudience] = useState<"customer" | "internal">("customer"); const [drafts, setDrafts] = useState(false);
  const [r, setR] = useState<{ connected: boolean; answer: string | null; note?: string; sources: Array<{ title: string; category: string; audience: string; text: string }> } | null>(null); const [busy, setBusy] = useState(false);
  async function run() { setBusy(true); try { setR(await api.post("/api/ai/knowledge/test", { question: q, audience, includeDrafts: drafts })); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }
  return (
    <Modal open onClose={onClose} title="בדוק את העוזר" width="max-w-2xl">
      <div className="space-y-3" data-testid="kb-test">
        <div className="flex gap-2"><Input aria-label="שאלה" className="flex-1" value={q} onChange={(e) => setQ(e.target.value)} placeholder="למשל: מה מדיניות ההחזרות?" data-testid="kb-test-q" /><Button onClick={run} loading={busy} data-testid="kb-test-run">בדוק</Button></div>
        <div className="flex gap-4 text-sm"><label className="flex items-center gap-1"><input type="radio" checked={audience === "customer"} onChange={() => setAudience("customer")} /> כמו מול לקוח</label><label className="flex items-center gap-1"><input type="radio" checked={audience === "internal"} onChange={() => setAudience("internal")} /> כמו עוזר פנימי</label><label className="flex items-center gap-1"><input type="checkbox" checked={drafts} onChange={(e) => setDrafts(e.target.checked)} /> כולל טיוטות (תצוגה מקדימה)</label></div>
        {r && <div className="space-y-2">
          {r.answer ? <div className="rounded-lg bg-panel-2 p-3 text-sm whitespace-pre-wrap" data-testid="kb-test-answer">{r.answer}</div> : <div className="text-sm text-warn" data-testid="kb-test-note">{r.note}</div>}
          <div className="text-xs text-muted">מקורות שנשלפו ({r.sources.length}):</div>
          {r.sources.map((s, i) => <div key={i} className="rounded border border-line p-2 text-xs" data-testid="kb-test-source"><div className="font-medium">[{i + 1}] {s.title} <Badge>{s.audience === "customer" ? "מול לקוחות" : "פנימי"}</Badge></div><div className="text-muted mt-1 line-clamp-4">{s.text}</div></div>)}
        </div>}
      </div>
    </Modal>
  );
}
