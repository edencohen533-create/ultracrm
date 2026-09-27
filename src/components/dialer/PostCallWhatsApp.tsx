"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { MessageCircle } from "lucide-react";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui";

interface Tpl { id: string; name: string; body: string; variables: string[]; headerFormat: string | null; internal?: boolean }
const LAST = "dialer.postCallTemplate";

/** After the call: send an approved WhatsApp template to the customer (the last one used is remembered). */
export function PostCallWhatsApp({ callId }: { callId: string }) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<Tpl[] | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [vars, setVars] = useState<Record<string, string>>({});
  const [media, setMedia] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  useEffect(() => { setSent(null); }, [callId]);
  useEffect(() => {
    if (!open || templates) return;
    fetch("/api/templates").then((r) => r.json()).then((j: { templates?: Tpl[] }) => { const list = (j.templates ?? []).filter((t) => !t.internal); setTemplates(list); let last = ""; try { last = localStorage.getItem(LAST) ?? ""; } catch { /* ignore */ } setTemplateId(list.some((t) => t.id === last) ? last : list[0]?.id ?? ""); }).catch(() => setTemplates([]));
  }, [open, templates]);
  const tpl = useMemo(() => templates?.find((t) => t.id === templateId) ?? null, [templates, templateId]);
  const needsMedia = ["IMAGE", "VIDEO", "DOCUMENT"].includes((tpl?.headerFormat ?? "").toUpperCase());
  const ready = tpl && tpl.variables.every((k) => vars[k]?.trim()) && (!needsMedia || /^https:\/\//.test(media));
  async function send() {
    if (!tpl) return; setBusy(true);
    try {
      await api.post(`/api/dialer/call/${callId}/whatsapp`, { templateId: tpl.id, variables: Object.fromEntries(tpl.variables.map((k) => [k, vars[k]])), ...(needsMedia ? { mediaUrl: media } : {}), requestId: crypto.randomUUID() });
      try { localStorage.setItem(LAST, tpl.id); } catch { /* ignore */ }
      setSent(tpl.name); setOpen(false); toast.success(`הודעת WhatsApp נשלחה (${tpl.name})`);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  if (sent) return <span className="post-wa-sent" data-testid="post-wa-sent">✓ נשלחה הודעת WhatsApp: {sent}</span>;
  if (!open) return <button type="button" className="post-wa-open" onClick={() => setOpen(true)} data-testid="post-wa-open"><MessageCircle size={14} />שלח הודעת WhatsApp ללקוח</button>;
  return (
    <div className="post-wa" data-testid="post-wa">
      {templates === null ? <span className="text-xs text-muted">טוען תבניות…</span> : !templates.length ? <span className="text-xs text-muted">אין תבניות WhatsApp מאושרות</span> : <>
        <select aria-label="תבנית" value={templateId} onChange={(e) => { setTemplateId(e.target.value); setVars({}); }} data-testid="post-wa-template">{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        {tpl?.variables.map((k) => <input key={k} aria-label={`משתנה ${k}`} placeholder={k === "h1" ? "כותרת" : `{{${k}}}`} value={vars[k] ?? ""} onChange={(e) => setVars({ ...vars, [k]: e.target.value })} data-testid={`post-wa-var-${k}`} />)}
        {needsMedia && <input aria-label="קישור מדיה" dir="ltr" placeholder="https://… (קובץ לכותרת)" value={media} onChange={(e) => setMedia(e.target.value)} />}
        {tpl && <span className="post-wa-body" title={tpl.body}>{tpl.body.slice(0, 80)}{tpl.body.length > 80 ? "…" : ""}</span>}
        <Button size="sm" variant="good" onClick={send} loading={busy} disabled={!ready} data-testid="post-wa-send">שלח</Button>
      </>}
      <button type="button" className="text-xs text-muted" onClick={() => setOpen(false)}>ביטול</button>
    </div>
  );
}
