"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { MAX_UPLOAD_BYTES, MEDIA_TYPES } from "@/lib/media";
import { renderTemplate, templateParameterKeys } from "@/lib/campaigns";
import type { MessageItem } from "@/types/domain";

type Template = { id: string; name: string; body: string; language?: string };
export function MessageComposer({ conversationId, disabled, disabledReason, senderUnavailable, onSent }: {
  conversationId: string; disabled?: boolean; disabledReason?: string; senderUnavailable?: string | null; onSent?: (message: MessageItem) => void;
}) {
  const draftWrites = useRef<Promise<void>>(Promise.resolve());
  const draftEdited = useRef(false);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestId = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [value, setValue] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [canned, setCanned] = useState<Array<{ id: string; title: string; body: string; shortcut: string | null }> | null>(null);
  async function loadCanned() {
    if (canned) return;
    try { const r = await fetch("/api/canned-replies"); if (!r.ok) throw new Error(); setCanned((await r.json()).data.items); } catch { toast.error("טעינת התשובות השמורות נכשלה"); }
  }
  const [showTemplates, setShowTemplates] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [variables, setVariables] = useState<Record<string, string>>({});
  const template = templates?.find((t) => t.id === templateId);
  const canSend = !senderUnavailable && (showTemplates ? !!template && templateParameterKeys(template.body).every((key) => variables[key]?.trim()) : !disabled && (!!value.trim() || !!file));

  // Serialize saves and clears: a slow clear after sending must never overwrite
  // the next message the agent has already started drafting.
  const saveDraft = useCallback((body: string) => {
    draftWrites.current = draftWrites.current.catch(() => {}).then(async () => {
      const response = await fetch(`/api/conversations/${conversationId}/draft`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }) });
      if (!response.ok) throw new Error("Draft save failed");
    });
    return draftWrites.current;
  }, [conversationId]);
  useEffect(() => {
    let alive = true;
    fetch(`/api/conversations/${conversationId}/draft`).then((r) => r.ok ? r.json() : null).then((d) => { if (alive && d?.body && !draftEdited.current) setValue(d.body); }).catch(() => {});
    return () => { alive = false; };
  }, [conversationId]);
  useEffect(() => {
    if (!draftEdited.current) return;
    draftTimer.current = setTimeout(() => { void saveDraft(value).catch(() => toast.error("שמירת הטיוטה נכשלה. אין לצאת לפני העתקת הטקסט")); }, 600);
    return () => { if (draftTimer.current) clearTimeout(draftTimer.current); };
  }, [value, saveDraft]);
  async function loadTemplates() {
    requestId.current = null;
    setShowTemplates(!showTemplates);
    if (templates) return;
    try {
      const response = await fetch("/api/templates");
      if (!response.ok) throw new Error();
      setTemplates((await response.json()).templates);
    } catch { toast.error("טעינת התבניות נכשלה"); setShowTemplates(false); }
  }
  async function handleSend() {
    if (!canSend || isSending) return;
    setIsSending(true);
    try {
      requestId.current ??= crypto.randomUUID();
      const form = new FormData();
      form.set("requestId", requestId.current);
      if (file) { form.set("file", file); form.set("caption", value); }
      const res = await fetch(`/api/conversations/${conversationId}/${file && !showTemplates ? "media" : "messages"}`, {
        method: "POST",
        ...(file && !showTemplates ? { body: form } : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...(showTemplates ? { templateId, templateVariables: variables } : { body: value }), requestId: requestId.current }),
        }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(typeof data.error === "string" ? data.error : "שליחת ההודעה נכשלה"); return; }
      if (data.message) onSent?.({ ...data.message, sentByUser: null });
      if (fileInput.current) fileInput.current.value = "";
      if (draftTimer.current) clearTimeout(draftTimer.current);
      draftEdited.current = false;
      requestId.current = null;
      void saveDraft("").catch(() => {});
      setValue(""); setFile(null); setTemplateId(""); setVariables({});
    } catch { toast.error("שגיאת תקשורת. יש לבדוק אם ההודעה נשלחה לפני ניסיון נוסף"); }
    finally { setIsSending(false); }
  }
  return <div className="space-y-2 border-t p-3">
    {senderUnavailable && <p role="alert" className="text-sm text-destructive">{senderUnavailable}</p>}
    {disabled && <p className="text-sm text-muted-foreground">{disabledReason ?? "חלון המענה הסתיים — יש להשתמש בתבנית מאושרת."}</p>}
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" onClick={loadTemplates}>{showTemplates ? "סגור תבניות" : "שליחת תבנית מאושרת"}</Button>
      {!showTemplates && !disabled && <select aria-label="תשובה שמורה" className="rounded-md border bg-background p-1.5 text-xs" onFocus={loadCanned} onChange={(e) => { const c = canned?.find((x) => x.id === e.target.value); if (c) { draftEdited.current = true; setValue((v) => (v ? `${v}\n${c.body}` : c.body)); } e.target.value = ""; }} defaultValue=""><option value="">תשובה שמורה…</option>{(canned ?? []).map((c) => <option key={c.id} value={c.id}>{c.shortcut ? `/${c.shortcut} · ` : ""}{c.title}</option>)}</select>}
    </div>
    {showTemplates ? <div className="space-y-2">
      <select aria-label="תבנית הודעה" className="w-full rounded-md border bg-background p-2" value={templateId} onChange={(e) => { setTemplateId(e.target.value); setVariables({}); requestId.current = null; }}><option value="">בחר תבנית</option>{templates?.map((t) => <option key={t.id} value={t.id}>{t.name}{t.language ? ` (${t.language})` : ""}</option>)}</select>
      {templates?.length === 0 && <p className="text-sm text-muted-foreground">אין תבניות מאושרות לשליחה.</p>}
      {template && <><div className="whitespace-pre-wrap rounded bg-muted p-3 text-sm">{renderTemplate(template.body, variables)}</div>{templateParameterKeys(template.body).map((key) => <Input key={key} aria-label={`משתנה ${key}`} placeholder={`ערך עבור משתנה ${key}`} value={variables[key] ?? ""} onChange={(e) => { setVariables({ ...variables, [key]: e.target.value }); requestId.current = null; }} maxLength={1024} />)}</>}
    </div> : !disabled && <Textarea disabled={isSending} value={value} onChange={(e) => { draftEdited.current = true; setValue(e.target.value); requestId.current = null; }} maxLength={file ? 1024 : 4096} onKeyDown={(e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void handleSend(); }
    }} placeholder="הקלד הודעה..." rows={2} className="resize-none" />}
    {!disabled && !showTemplates && <div className="flex items-center gap-2">
      <label className="text-xs text-muted-foreground">צרף קובץ עד 4MB<Input aria-label="צירוף קובץ" type="file" ref={fileInput} disabled={isSending} accept={Object.keys(MEDIA_TYPES).join(",")} onChange={(e) => {
        const selected = e.target.files?.[0];
        if (selected && selected.size > MAX_UPLOAD_BYTES) { toast.error("מותר להעלות קובץ עד 4MB"); e.target.value = ""; return; }
        requestId.current = null; setFile(selected ?? null);
      }} /></label>
      {file && <Button variant="ghost" size="sm" onClick={() => { setFile(null); if (fileInput.current) fileInput.current.value = ""; }}>הסר קובץ: {file.name}</Button>}
    </div>}
    {(showTemplates || !disabled) && <Button onClick={handleSend} disabled={isSending || !canSend}><Send className="h-4 w-4" />{isSending ? "שולח..." : "שלח"}</Button>}
  </div>;
}
