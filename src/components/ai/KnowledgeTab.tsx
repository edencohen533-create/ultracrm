"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, EmptyState, Input, Modal, Panel, Select, Spinner, Textarea } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

interface Source { id: string; title: string; category: string; kind: "text" | "file" | "link" | "conversation"; audience: "internal" | "customer"; salesShared?: boolean; status: "draft" | "approved" | "retired"; learnMode?: "info" | "style" | "both" | null; sourceConversationId?: string | null; conflicts?: Array<{ title: string; detail: string }> | null; proposedBy?: string | null; approvedBy?: string | null; processing: "pending" | "processing" | "ready" | "failed"; error: string | null; url: string | null; fileName: string | null; chunks: number; updatedAt: string }
const PROC: Record<Source["processing"], { l: string; en: string; t: "neutral" | "warn" | "good" | "bad" }> = { pending: { l: "ממתין", en: "Pending", t: "neutral" }, processing: { l: "בעיבוד", en: "Processing", t: "warn" }, ready: { l: "מוכן", en: "Ready", t: "good" }, failed: { l: "נכשל", en: "Failed", t: "bad" } };
const KIND: Record<Source["kind"], [string, string]> = { text: ["טקסט", "Text"], file: ["קובץ", "File"], link: ["קישור", "Link"], conversation: ["נלמד משיחה", "Learned from conversation"] };
/** Category names come from the API in Hebrew; English by key. */
const CAT_EN: Record<string, string> = { business: "Business details & hours", products: "Products & services", faq: "FAQ", policy: "Shipping, cancellations & returns", guidelines: "Service & sales guidelines", docs: "Documents & sources" };
const MODE: Record<string, [string, string]> = { info: ["מידע ותהליך", "Info & process"], style: ["סגנון בלבד", "Style only"], both: ["מידע + סגנון", "Info + style"] };

export function KnowledgeTab() {
  const t = useT();
  const [items, setItems] = useState<Source[] | null>(null); const [cats, setCats] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false); const [testOpen, setTestOpen] = useState(false); const [filter, setFilter] = useState("");
  const load = useCallback(async () => { try { const r = await api.get<{ items: Source[]; categories: Record<string, string> }>("/api/ai/knowledge"); setItems(r.items); setCats(Object.fromEntries(Object.entries(r.categories).map(([k, v]) => [k, t(v, CAT_EN[k] ?? v)]))); } catch (e) { toast.error((e as Error).message); } }, [t]);
  useEffect(() => { void load(); }, [load]);
  async function patch(s: Source, body: Record<string, unknown>) { try { await api.patch(`/api/ai/knowledge/${s.id}`, body); await load(); } catch (e) { toast.error((e as Error).message); } }
  async function remove(s: Source) { if (!confirm(t(`למחוק את "${s.title}"? הוא יוסר מיד מהתשובות.`, `Delete "${s.title}"? It will be removed from answers immediately.`))) return; try { await api.delete(`/api/ai/knowledge/${s.id}`); await load(); } catch (e) { toast.error((e as Error).message); } }
  async function retry(s: Source) { try { await api.post(`/api/ai/knowledge/${s.id}/retry`); await load(); } catch (e) { toast.error((e as Error).message); } }
  if (!items) return <div className="py-10 flex justify-center"><Spinner /></div>;
  const shown = items.filter((s) => !filter || s.category === filter);
  return (
    <div className="space-y-4" data-testid="ai-knowledge">
      <div className="rounded-lg border border-line bg-panel p-3 text-sm space-y-1" data-testid="kb-scope">
        <p><b>{t("שירות לקוחות", "Customer service")}</b> – {t("ידע שהעוזר ונציג השירות ב-WhatsApp עונים לפיו: פרטי העסק, מוצרים, מדיניות, שאלות נפוצות.", "Knowledge the assistant and the WhatsApp service agent answer from: business details, products, policies, FAQs.")}</p>
        <p className="text-xs text-muted">{t("ידע וטכניקות מכירה (פתיחה, התנגדויות, סגירה) נמצאים ב״מאמן מכירות״. מקור מאושר כאן משמש גם את עוזר המכירות בחייגן רק אם סימנתם ״שיתוף עם מאמן המכירות״ – כעובדה על מוצר, מחיר או מדיניות, לא כניסוח מכירתי.", "Sales knowledge and techniques (openings, objections, closing) live in 'Sales coach'. An approved source here is also used by the in-call sales assistant only if you tick 'Share with the sales coach' – as a fact about a product, price or policy, not as sales phrasing.")}</p>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <Button onClick={() => setAdding(true)} data-testid="kb-add">{t("הוספת ידע", "Add knowledge")}</Button>
        <Button variant="secondary" onClick={() => setTestOpen(true)} data-testid="kb-test-open">{t("בדוק את העוזר", "Test the assistant")}</Button>
        <Select aria-label={t("סינון קטגוריה", "Filter category")} value={filter} onChange={(e) => setFilter(e.target.value)} className="w-56"><option value="">{t("כל הקטגוריות", "All categories")}</option>{Object.entries(cats).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
      </div>
      <p className="text-xs text-muted">{t.lang === "en" ? <>New knowledge is saved as a <b>draft</b> and <b>internal only</b>. The assistant uses only approved knowledge, and the customer service agent – only approved knowledge marked &quot;Allowed with customers&quot;. Live data (current price, stock, order status) is not taken from here.</> : <>ידע חדש נשמר כ<b>טיוטה</b> ו<b>פנימי בלבד</b>. העוזר משתמש רק בידע מאושר, ונציג השירות ללקוחות – רק בידע מאושר שסומן &quot;מותר מול לקוחות&quot;. נתונים חיים (מחיר עדכני, מלאי, סטטוס הזמנה) לא נלקחים מכאן.</>}</p>
      {!shown.length ? <EmptyState title={t("עדיין אין ידע", "No knowledge yet")} hint={t("הוסיפו שעות פעילות, מדיניות משלוחים והחזרות, שאלות נפוצות ומסמכים", "Add business hours, shipping and returns policies, FAQs and documents")} /> :
        <Panel bodyClassName="p-0"><table className="w-full text-sm"><thead className="text-xs text-muted"><tr><th className="text-start p-2">{t("כותרת", "Title")}</th><th className="text-start">{t("קטגוריה", "Category")}</th><th className="text-start">{t("סוג", "Type")}</th><th className="text-start">{t("עיבוד", "Processing")}</th><th className="text-start">{t("קהל", "Audience")}</th><th className="text-start">{t("מאמן מכירות", "Sales coach")}</th><th className="text-start">{t("סטטוס", "Status")}</th><th /></tr></thead>
          <tbody className="divide-y divide-line">{shown.map((s) => <tr key={s.id} data-testid="kb-row">
            <td className="p-2"><div className="font-medium">{s.title}</div>{s.kind === "conversation" && <div className="text-xs text-muted" data-testid="kb-learned-meta">{s.learnMode && MODE[s.learnMode] ? t(MODE[s.learnMode][0], MODE[s.learnMode][1]) : ""}{s.proposedBy ? ` · ${t("הציע:", "Proposed by:")} ${s.proposedBy}` : ""}{s.approvedBy ? ` · ${t("אישר:", "Approved by:")} ${s.approvedBy}` : ""}{s.sourceConversationId && <> · <a className="underline" href={`/inbox/${s.sourceConversationId}`}>{t("שיחת המקור", "Source conversation")}</a></>}</div>}{s.conflicts?.length ? <div className="text-xs text-bad" data-testid="kb-conflict">{t("סתירה אפשרית:", "Possible conflict:")} {s.conflicts.map((c) => `${c.title} – ${c.detail}`).join("; ")}</div> : null}{s.url && <div className="text-xs text-muted ltr text-start truncate max-w-xs">{s.url}</div>}{s.fileName && <div className="text-xs text-muted">{s.fileName}</div>}</td>
            <td className="text-muted">{cats[s.category] ?? s.category}</td><td>{t(KIND[s.kind][0], KIND[s.kind][1])}</td>
            <td><Badge tone={PROC[s.processing].t}>{t(PROC[s.processing].l, PROC[s.processing].en)}{s.processing === "ready" ? ` · ${s.chunks}` : ""}</Badge>{s.error && <div className="text-xs text-bad max-w-[200px]">{s.error}</div>}</td>
            <td><Select aria-label={t("קהל", "Audience")} value={s.audience} onChange={(e) => patch(s, { audience: e.target.value })} className="w-40"><option value="internal">{t("פנימי בלבד", "Internal only")}</option><option value="customer">{t("מותר מול לקוחות", "Allowed with customers")}</option></Select></td>
            <td><label className="flex items-center gap-1 text-xs" title={s.status !== "approved" ? t("אפשר לשתף רק ידע מאושר", "Only approved knowledge can be shared") : undefined}><input type="checkbox" checked={Boolean(s.salesShared)} disabled={s.status !== "approved"} onChange={(e) => patch(s, { salesShared: e.target.checked })} data-testid="kb-sales-shared" /> {t("שיתוף", "Share")}</label></td>
            <td>{s.status === "approved" ? <Badge tone="good">{t("מאושר", "Approved")}</Badge> : s.status === "retired" ? <Badge tone="neutral">{t("הוצא משימוש", "Retired")}</Badge> : <Badge>{t("טיוטה", "Draft")}</Badge>}</td>
            <td className="whitespace-nowrap space-x-1 space-x-reverse p-2">
              {s.status !== "approved" ? <Button size="sm" disabled={s.processing !== "ready"} onClick={() => { if (s.conflicts?.length && !confirm(t(`יש סתירה אפשרית מול ידע מאושר:\n${s.conflicts.map((c) => `${c.title} – ${c.detail}`).join("\n")}\n\nלאשר בכל זאת?`, `Possible conflict with approved knowledge:\n${s.conflicts.map((c) => `${c.title} – ${c.detail}`).join("\n")}\n\nApprove anyway?`))) return; void patch(s, { status: "approved", acknowledgeConflicts: Boolean(s.conflicts?.length) }); }} data-testid="kb-approve">{t("אשר", "Approve")}</Button> : <><Button size="sm" variant="ghost" onClick={() => patch(s, { status: "draft" })}>{t("החזר לטיוטה", "Back to draft")}</Button><Button size="sm" variant="ghost" onClick={() => patch(s, { status: "retired" })} data-testid="kb-retire">{t("הוצא משימוש", "Retire")}</Button></>}
              {s.processing === "failed" && <Button size="sm" variant="secondary" onClick={() => retry(s)} data-testid="kb-retry">{t("נסה שוב", "Retry")}</Button>}
              <Button size="sm" variant="ghost" onClick={() => remove(s)}>{t("מחק", "Delete")}</Button>
            </td></tr>)}</tbody></table></Panel>}
      {adding && <AddSource cats={cats} onClose={() => setAdding(false)} onDone={() => { setAdding(false); void load(); }} />}
      {testOpen && <TestAssistant onClose={() => setTestOpen(false)} />}
    </div>
  );
}

function AddSource({ cats, onClose, onDone }: { cats: Record<string, string>; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [kind, setKind] = useState<"text" | "file" | "link">("text"); const [title, setTitle] = useState(""); const [category, setCategory] = useState("faq");
  const [content, setContent] = useState(""); const [url, setUrl] = useState(""); const [file, setFile] = useState<File | null>(null); const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      let r: { processing: string; error: string | null };
      if (kind === "file") {
        if (!file) throw new Error(t("בחרו קובץ", "Choose a file"));
        const fd = new FormData(); fd.set("file", file); fd.set("title", title || file.name); fd.set("category", category);
        const res = await fetch("/api/ai/knowledge", { method: "POST", body: fd }); const j = await res.json();
        if (!res.ok || j.success === false) throw new Error(j.error ?? t("ההעלאה נכשלה", "Upload failed")); r = j.data;
      } else r = await api.post("/api/ai/knowledge", { kind, title, category, ...(kind === "text" ? { content } : { url }) });
      if (r.processing === "failed") toast.error(t(`נשמר, אך העיבוד נכשל: ${r.error}`, `Saved, but processing failed: ${r.error}`)); else toast.success(t("נשמר כטיוטה – אשרו כדי שהעוזר ישתמש בו", "Saved as draft – approve it so the assistant can use it"));
      onDone();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={t("הוספת ידע", "Add knowledge")} footer={<><Button variant="ghost" onClick={onClose}>{t("ביטול", "Cancel")}</Button><Button onClick={save} loading={busy} data-testid="kb-save">{t("שמור", "Save")}</Button></>}>
      <div className="space-y-3">
        <div className="flex gap-2">{(["text", "file", "link"] as const).map((k) => <Button key={k} size="sm" variant={kind === k ? "primary" : "secondary"} onClick={() => setKind(k)}>{t(KIND[k][0], KIND[k][1])}</Button>)}</div>
        <Input label={t("כותרת", "Title")} value={title} onChange={(e) => setTitle(e.target.value)} data-testid="kb-title" />
        <Select label={t("קטגוריה", "Category")} value={category} onChange={(e) => setCategory(e.target.value)}>{Object.entries(cats).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        {kind === "text" && <Textarea label={t("תוכן", "Content")} rows={8} value={content} onChange={(e) => setContent(e.target.value)} data-testid="kb-content" />}
        {kind === "link" && <Input label={t("קישור (https ציבורי בלבד)", "Link (public https only)")} ltr value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />}
        {kind === "file" && <div><input type="file" accept=".pdf,.txt,.md,.csv,.html,.htm,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /><p className="text-xs text-muted mt-1">{t("PDF, TXT, MD, CSV, HTML עד 5MB", "PDF, TXT, MD, CSV, HTML up to 5MB")}</p></div>}
      </div>
    </Modal>
  );
}

function TestAssistant({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [q, setQ] = useState(""); const [audience, setAudience] = useState<"customer" | "internal">("customer"); const [drafts, setDrafts] = useState(false);
  const [r, setR] = useState<{ connected: boolean; answer: string | null; note?: string; sources: Array<{ title: string; category: string; audience: string; text: string }> } | null>(null); const [busy, setBusy] = useState(false);
  async function run() { setBusy(true); try { setR(await api.post("/api/ai/knowledge/test", { question: q, audience, includeDrafts: drafts })); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }
  return (
    <Modal open onClose={onClose} title={t("בדוק את העוזר", "Test the assistant")} width="max-w-2xl">
      <div className="space-y-3" data-testid="kb-test">
        <div className="flex gap-2"><Input aria-label={t("שאלה", "Question")} className="flex-1" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("למשל: מה מדיניות ההחזרות?", "e.g. What is the returns policy?")} data-testid="kb-test-q" /><Button onClick={run} loading={busy} data-testid="kb-test-run">{t("בדוק", "Test")}</Button></div>
        <div className="flex gap-4 text-sm"><label className="flex items-center gap-1"><input type="radio" checked={audience === "customer"} onChange={() => setAudience("customer")} /> {t("כמו מול לקוח", "As with a customer")}</label><label className="flex items-center gap-1"><input type="radio" checked={audience === "internal"} onChange={() => setAudience("internal")} /> {t("כמו עוזר פנימי", "As internal assistant")}</label><label className="flex items-center gap-1"><input type="checkbox" checked={drafts} onChange={(e) => setDrafts(e.target.checked)} /> {t("כולל טיוטות (תצוגה מקדימה)", "Include drafts (preview)")}</label></div>
        {r && <div className="space-y-2">
          {r.answer ? <div className="rounded-lg bg-panel-2 p-3 text-sm whitespace-pre-wrap" data-testid="kb-test-answer">{r.answer}</div> : <div className="text-sm text-warn" data-testid="kb-test-note">{r.note}</div>}
          <div className="text-xs text-muted">{t(`מקורות שנשלפו (${r.sources.length}):`, `Retrieved sources (${r.sources.length}):`)}</div>
          {r.sources.map((s, i) => <div key={i} className="rounded border border-line p-2 text-xs" data-testid="kb-test-source"><div className="font-medium">[{i + 1}] {s.title} <Badge>{s.audience === "customer" ? t("מול לקוחות", "Customer-facing") : t("פנימי", "Internal")}</Badge></div><div className="text-muted mt-1 line-clamp-4">{s.text}</div></div>)}
        </div>}
      </div>
    </Modal>
  );
}
