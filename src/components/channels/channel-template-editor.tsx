"use client";

/**
 * SMS template editor (segment counter) and email block editor (heading / text / image /
 * button / link / divider / footer) with live preview. Templates are saved through
 * /api/channels/{channel}/templates and become sendable immediately.
 */
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { smsMetrics, SMS_MAX_SEGMENTS } from "@/lib/sms";
import { BLOCK_LABELS, defaultEmailDesign, newEmailBlock, type EmailBlock, type EmailDesign } from "@/lib/email/blocks";
import { useT } from "@/components/i18n/LangProvider";

export interface ChannelTemplateRow { id: string; channel: string; name: string; category: string; body: string; subject: string | null; preheader: string | null; design: unknown; _count?: { campaigns: number } }

const TAG_HELP: [string, string] = ["משתנים: {{name}} {{first_name|לקוח}} {{company|}} {{city|}} {{custom.מפתח|ברירת מחדל}}", "Variables: {{name}} {{first_name|Customer}} {{company|}} {{city|}} {{custom.key|default}}"];

export function SmsTemplateDialog({ existing, trigger }: { existing?: ChannelTemplateRow; trigger?: React.ReactNode }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(existing?.name ?? "");
  const [category, setCategory] = useState(existing?.category ?? "MARKETING");
  const [body, setBody] = useState(existing?.body ?? "");
  const [busy, setBusy] = useState(false);
  const preview = useMemo(() => body.replace(/\{\{\s*first_name\s*(?:\|[^}]*)?\}\}/g, "ישראל").replace(/\{\{\s*name\s*(?:\|[^}]*)?\}\}/g, "ישראל ישראלי").replace(/\{\{[^}|]+\|([^}]*)\}\}/g, "$1") + (category === "MARKETING" ? "\nלהסרה השיבו הסר" : ""), [body, category]);
  const m = smsMetrics(preview);
  async function save() {
    setBusy(true);
    try { await api.post("/api/channels/sms/templates", { channel: "sms", id: existing?.id, name, category, body }); toast.success(t("התבנית נשמרה", "Template saved")); setOpen(false); router.refresh(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant={existing ? "ghost" : "default"} size="sm" />}>{trigger ?? (existing ? t("עריכה", "Edit") : t("תבנית SMS חדשה", "New SMS template"))}</DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{existing ? t("עריכת תבנית SMS", "Edit SMS template") : t("תבנית SMS חדשה", "New SMS template")}</DialogTitle></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><Label>{t("שם", "Name")}</Label><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></div>
          <div><Label>{t("קטגוריה", "Category")}</Label><select className="mt-1 w-full rounded-md border bg-background p-2 text-sm" value={category} onChange={(e) => setCategory(e.target.value)}><option value="MARKETING">{t("שיווקי (דורש הסכמה, כולל הסרה)", "Marketing (requires consent, includes opt-out)")}</option><option value="UTILITY">{t("שירות", "Utility")}</option></select></div>
          <div className="sm:col-span-2"><Label>{t("תוכן", "Content")}</Label><Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} maxLength={1600} /><p className="mt-1 text-xs text-muted-foreground">{t(TAG_HELP[0], TAG_HELP[1])}</p></div>
          <div className="sm:col-span-2 rounded-lg bg-muted p-3 text-sm whitespace-pre-wrap" data-testid="sms-preview">{preview || t("תצוגה מקדימה", "Preview")}</div>
          <p className={`sm:col-span-2 text-xs ${m.segments > SMS_MAX_SEGMENTS ? "text-destructive" : "text-muted-foreground"}`} data-testid="sms-metrics">{t(`קידוד ${m.encoding} · ${m.length} תווים · ${m.segments} מקטע${m.segments === 1 ? "" : "ים"} (${m.perSegment} למקטע) · נותרו ${m.remaining} עד המקטע הבא${category === "MARKETING" ? " · כולל שורת הסרה" : ""}`, `${m.encoding} encoding · ${m.length} characters · ${m.segments} segment${m.segments === 1 ? "" : "s"} (${m.perSegment} per segment) · ${m.remaining} left until the next segment${category === "MARKETING" ? " · includes opt-out line" : ""}`)}</p>
        </div>
        <div className="mt-3 flex justify-end gap-2"><Button variant="ghost" onClick={() => setOpen(false)}>{t("ביטול", "Cancel")}</Button><Button onClick={save} disabled={busy || !name.trim() || !body.trim() || m.segments > SMS_MAX_SEGMENTS}>{t("שמור", "Save")}</Button></div>
      </DialogContent>
    </Dialog>
  );
}

const BLOCK_LABEL: Partial<typeof BLOCK_LABELS> = { heading: BLOCK_LABELS.heading, text: BLOCK_LABELS.text, image: BLOCK_LABELS.image, button: BLOCK_LABELS.button, link: BLOCK_LABELS.link, divider: BLOCK_LABELS.divider, footer: BLOCK_LABELS.footer };
const newBlock = newEmailBlock;

export function EmailTemplateDialog({ existing, trigger }: { existing?: ChannelTemplateRow; trigger?: React.ReactNode }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(existing?.name ?? "");
  const [category, setCategory] = useState(existing?.category ?? "MARKETING");
  const [subject, setSubject] = useState(existing?.subject ?? "");
  const [preheader, setPreheader] = useState(existing?.preheader ?? "");
  const [design, setDesign] = useState<EmailDesign>((existing?.design as EmailDesign | null) ?? defaultEmailDesign());
  const [html, setHtml] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(async () => {
      try { const r = await api.post<{ html: string; problems: string[]; missing: string[] }>("/api/channels/email/preview", { subject, preheader, design }); setHtml(r.html); setProblems([...r.problems, ...r.missing.map((m) => t(`חסר ערך/ברירת מחדל ל-{{${m}}}`, `Missing value/default for {{${m}}}`))]); }
      catch (e) { setProblems([(e as Error).message]); }
    }, 400);
    return () => clearTimeout(timer);
  }, [open, subject, preheader, design, t]);
  const update = (i: number, patch: Partial<EmailBlock>) => setDesign({ ...design, blocks: design.blocks.map((b, j) => (j === i ? ({ ...b, ...patch } as EmailBlock) : b)) });
  const move = (i: number, d: -1 | 1) => { const blocks = [...design.blocks]; const j = i + d; if (j < 0 || j >= blocks.length) return; [blocks[i], blocks[j]] = [blocks[j], blocks[i]]; setDesign({ ...design, blocks }); };
  async function save() {
    setBusy(true);
    try { await api.post("/api/channels/email/templates", { channel: "email", id: existing?.id, name, category, subject, preheader: preheader || undefined, design }); toast.success(t("התבנית נשמרה", "Template saved")); setOpen(false); router.refresh(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant={existing ? "ghost" : "default"} size="sm" />}>{trigger ?? (existing ? t("עריכה", "Edit") : t("תבנית אימייל חדשה", "New email template"))}</DialogTrigger>
      <DialogContent className="max-w-5xl max-h-[90dvh] overflow-auto">
        <DialogHeader><DialogTitle>{existing ? t("עריכת תבנית אימייל", "Edit email template") : t("תבנית אימייל חדשה", "New email template")}</DialogTitle></DialogHeader>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div><Label>{t("שם", "Name")}</Label><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></div>
              <div><Label>{t("קטגוריה", "Category")}</Label><select className="mt-1 w-full rounded-md border bg-background p-2 text-sm" value={category} onChange={(e) => setCategory(e.target.value)}><option value="MARKETING">{t("שיווקי", "Marketing")}</option><option value="UTILITY">{t("שירות", "Utility")}</option></select></div>
              <div><Label>{t("נושא", "Subject")}</Label><Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} /></div>
              <div><Label>{t("טקסט מקדים (preheader)", "Preheader text")}</Label><Input value={preheader} onChange={(e) => setPreheader(e.target.value)} maxLength={200} /></div>
            </div>
            <p className="text-xs text-muted-foreground">{t(TAG_HELP[0], TAG_HELP[1])} · {t("קישור ההסרה {{unsubscribe_url}} מתווסף אוטומטית בכותרת התחתונה.", "The unsubscribe link {{unsubscribe_url}} is added automatically in the footer.")}</p>
            <div className="space-y-2">
              {design.blocks.map((b, i) => (
                <div key={i} className="rounded-lg border p-2 text-sm">
                  <div className="flex items-center justify-between"><span className="font-medium">{BLOCK_LABEL[b.type]}</span><span className="flex gap-1"><Button variant="ghost" size="sm" onClick={() => move(i, -1)}>↑</Button><Button variant="ghost" size="sm" onClick={() => move(i, 1)}>↓</Button><Button variant="ghost" size="sm" onClick={() => setDesign({ ...design, blocks: design.blocks.filter((_, j) => j !== i) })}>{t("מחק", "Delete")}</Button></span></div>
                  {(b.type === "heading" || b.type === "text") && <Textarea value={b.text} onChange={(e) => update(i, { text: e.target.value })} rows={b.type === "text" ? 3 : 1} />}
                  {b.type === "heading" && <select className="mt-1 rounded-md border bg-background p-1 text-xs" value={b.level} onChange={(e) => update(i, { level: Number(e.target.value) as 1 | 2 | 3 })}><option value={1}>H1</option><option value={2}>H2</option><option value={3}>H3</option></select>}
                  {b.type === "image" && <div className="grid gap-1 sm:grid-cols-2"><Input placeholder={t("כתובת תמונה https://", "Image URL https://")} value={b.src} onChange={(e) => update(i, { src: e.target.value })} dir="ltr" /><Input placeholder={t("טקסט חלופי", "Alt text")} value={b.alt} onChange={(e) => update(i, { alt: e.target.value })} /><Input placeholder={t("קישור (אופציונלי)", "Link (optional)")} value={b.href ?? ""} onChange={(e) => update(i, { href: e.target.value || undefined })} dir="ltr" /></div>}
                  {b.type === "button" && <div className="grid gap-1 sm:grid-cols-3"><Input value={b.text} onChange={(e) => update(i, { text: e.target.value })} /><Input value={b.href} onChange={(e) => update(i, { href: e.target.value })} dir="ltr" placeholder="https://" /><Input type="color" value={b.color} onChange={(e) => update(i, { color: e.target.value })} /></div>}
                  {b.type === "link" && <div className="grid gap-1 sm:grid-cols-2"><Input value={b.text} onChange={(e) => update(i, { text: e.target.value })} /><Input value={b.href} onChange={(e) => update(i, { href: e.target.value })} dir="ltr" /></div>}
                  {b.type === "footer" && <div className="grid gap-1"><Input value={b.text} onChange={(e) => update(i, { text: e.target.value })} placeholder={t("פרטי העסק", "Business details")} /><Input value={b.unsubscribeText} onChange={(e) => update(i, { unsubscribeText: e.target.value })} /></div>}
                </div>
              ))}
              <div className="flex flex-wrap gap-1">{(Object.keys(BLOCK_LABEL) as EmailBlock["type"][]).map((bt) => <Button key={bt} variant="outline" size="sm" onClick={() => setDesign({ ...design, blocks: [...design.blocks, newBlock(bt)] })}>+ {BLOCK_LABEL[bt]}</Button>)}</div>
            </div>
            {problems.length > 0 && <ul className="text-xs text-destructive list-disc pe-4">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
          </div>
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{t("תצוגה מקדימה (נמען לדוגמה, רוחב מובייל/דסקטופ)", "Preview (sample recipient, mobile/desktop width)")}</p>
            <iframe title="preview" className="h-[520px] w-full rounded-lg border bg-white" srcDoc={html} sandbox="" />
          </div>
        </div>
        <div className="mt-3 flex justify-end gap-2"><Button variant="ghost" onClick={() => setOpen(false)}>{t("ביטול", "Cancel")}</Button><Button onClick={save} disabled={busy || !name.trim() || !subject.trim() || problems.length > 0}>{t("שמור", "Save")}</Button></div>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteTemplateButton({ channel, id }: { channel: string; id: string }) {
  const t = useT();
  const router = useRouter();
  return <Button variant="ghost" size="sm" onClick={async () => { if (!confirm(t("למחוק את התבנית?", "Delete this template?"))) return; try { await api.delete(`/api/channels/${channel}/templates`, { id }); toast.success(t("נמחקה", "Deleted")); router.refresh(); } catch (e) { toast.error((e as Error).message); } }}>{t("מחק", "Delete")}</Button>;
}
