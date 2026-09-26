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

export interface ChannelTemplateRow { id: string; channel: string; name: string; category: string; body: string; subject: string | null; preheader: string | null; design: unknown; _count?: { campaigns: number } }

const TAG_HELP = "משתנים: {{name}} {{first_name|לקוח}} {{company|}} {{city|}} {{custom.מפתח|ברירת מחדל}}";

export function SmsTemplateDialog({ existing, trigger }: { existing?: ChannelTemplateRow; trigger?: React.ReactNode }) {
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
    try { await api.post("/api/channels/sms/templates", { channel: "sms", id: existing?.id, name, category, body }); toast.success("התבנית נשמרה"); setOpen(false); router.refresh(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant={existing ? "ghost" : "default"} size="sm" />}>{trigger ?? (existing ? "עריכה" : "תבנית SMS חדשה")}</DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{existing ? "עריכת תבנית SMS" : "תבנית SMS חדשה"}</DialogTitle></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><Label>שם</Label><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></div>
          <div><Label>קטגוריה</Label><select className="mt-1 w-full rounded-md border bg-background p-2 text-sm" value={category} onChange={(e) => setCategory(e.target.value)}><option value="MARKETING">שיווקי (דורש הסכמה, כולל הסרה)</option><option value="UTILITY">שירות</option></select></div>
          <div className="sm:col-span-2"><Label>תוכן</Label><Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} maxLength={1600} /><p className="mt-1 text-xs text-muted-foreground">{TAG_HELP}</p></div>
          <div className="sm:col-span-2 rounded-lg bg-muted p-3 text-sm whitespace-pre-wrap" data-testid="sms-preview">{preview || "תצוגה מקדימה"}</div>
          <p className={`sm:col-span-2 text-xs ${m.segments > SMS_MAX_SEGMENTS ? "text-destructive" : "text-muted-foreground"}`} data-testid="sms-metrics">קידוד {m.encoding} · {m.length} תווים · {m.segments} מקטע{m.segments === 1 ? "" : "ים"} ({m.perSegment} למקטע) · נותרו {m.remaining} עד המקטע הבא{category === "MARKETING" ? " · כולל שורת הסרה" : ""}</p>
        </div>
        <div className="mt-3 flex justify-end gap-2"><Button variant="ghost" onClick={() => setOpen(false)}>ביטול</Button><Button onClick={save} disabled={busy || !name.trim() || !body.trim() || m.segments > SMS_MAX_SEGMENTS}>שמור</Button></div>
      </DialogContent>
    </Dialog>
  );
}

const BLOCK_LABEL: Partial<typeof BLOCK_LABELS> = { heading: BLOCK_LABELS.heading, text: BLOCK_LABELS.text, image: BLOCK_LABELS.image, button: BLOCK_LABELS.button, link: BLOCK_LABELS.link, divider: BLOCK_LABELS.divider, footer: BLOCK_LABELS.footer };
const newBlock = newEmailBlock;

export function EmailTemplateDialog({ existing, trigger }: { existing?: ChannelTemplateRow; trigger?: React.ReactNode }) {
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
    const t = setTimeout(async () => {
      try { const r = await api.post<{ html: string; problems: string[]; missing: string[] }>("/api/channels/email/preview", { subject, preheader, design }); setHtml(r.html); setProblems([...r.problems, ...r.missing.map((m) => `חסר ערך/ברירת מחדל ל-{{${m}}}`)]); }
      catch (e) { setProblems([(e as Error).message]); }
    }, 400);
    return () => clearTimeout(t);
  }, [open, subject, preheader, design]);
  const update = (i: number, patch: Partial<EmailBlock>) => setDesign({ ...design, blocks: design.blocks.map((b, j) => (j === i ? ({ ...b, ...patch } as EmailBlock) : b)) });
  const move = (i: number, d: -1 | 1) => { const blocks = [...design.blocks]; const j = i + d; if (j < 0 || j >= blocks.length) return; [blocks[i], blocks[j]] = [blocks[j], blocks[i]]; setDesign({ ...design, blocks }); };
  async function save() {
    setBusy(true);
    try { await api.post("/api/channels/email/templates", { channel: "email", id: existing?.id, name, category, subject, preheader: preheader || undefined, design }); toast.success("התבנית נשמרה"); setOpen(false); router.refresh(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant={existing ? "ghost" : "default"} size="sm" />}>{trigger ?? (existing ? "עריכה" : "תבנית אימייל חדשה")}</DialogTrigger>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-auto">
        <DialogHeader><DialogTitle>{existing ? "עריכת תבנית אימייל" : "תבנית אימייל חדשה"}</DialogTitle></DialogHeader>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div><Label>שם</Label><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></div>
              <div><Label>קטגוריה</Label><select className="mt-1 w-full rounded-md border bg-background p-2 text-sm" value={category} onChange={(e) => setCategory(e.target.value)}><option value="MARKETING">שיווקי</option><option value="UTILITY">שירות</option></select></div>
              <div><Label>נושא</Label><Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} /></div>
              <div><Label>טקסט מקדים (preheader)</Label><Input value={preheader} onChange={(e) => setPreheader(e.target.value)} maxLength={200} /></div>
            </div>
            <p className="text-xs text-muted-foreground">{TAG_HELP} · קישור ההסרה {"{{unsubscribe_url}}"} מתווסף אוטומטית בכותרת התחתונה.</p>
            <div className="space-y-2">
              {design.blocks.map((b, i) => (
                <div key={i} className="rounded-lg border p-2 text-sm">
                  <div className="flex items-center justify-between"><span className="font-medium">{BLOCK_LABEL[b.type]}</span><span className="flex gap-1"><Button variant="ghost" size="sm" onClick={() => move(i, -1)}>↑</Button><Button variant="ghost" size="sm" onClick={() => move(i, 1)}>↓</Button><Button variant="ghost" size="sm" onClick={() => setDesign({ ...design, blocks: design.blocks.filter((_, j) => j !== i) })}>מחק</Button></span></div>
                  {(b.type === "heading" || b.type === "text") && <Textarea value={b.text} onChange={(e) => update(i, { text: e.target.value })} rows={b.type === "text" ? 3 : 1} />}
                  {b.type === "heading" && <select className="mt-1 rounded-md border bg-background p-1 text-xs" value={b.level} onChange={(e) => update(i, { level: Number(e.target.value) as 1 | 2 | 3 })}><option value={1}>H1</option><option value={2}>H2</option><option value={3}>H3</option></select>}
                  {b.type === "image" && <div className="grid gap-1 sm:grid-cols-2"><Input placeholder="כתובת תמונה https://" value={b.src} onChange={(e) => update(i, { src: e.target.value })} dir="ltr" /><Input placeholder="טקסט חלופי" value={b.alt} onChange={(e) => update(i, { alt: e.target.value })} /><Input placeholder="קישור (אופציונלי)" value={b.href ?? ""} onChange={(e) => update(i, { href: e.target.value || undefined })} dir="ltr" /></div>}
                  {b.type === "button" && <div className="grid gap-1 sm:grid-cols-3"><Input value={b.text} onChange={(e) => update(i, { text: e.target.value })} /><Input value={b.href} onChange={(e) => update(i, { href: e.target.value })} dir="ltr" placeholder="https://" /><Input type="color" value={b.color} onChange={(e) => update(i, { color: e.target.value })} /></div>}
                  {b.type === "link" && <div className="grid gap-1 sm:grid-cols-2"><Input value={b.text} onChange={(e) => update(i, { text: e.target.value })} /><Input value={b.href} onChange={(e) => update(i, { href: e.target.value })} dir="ltr" /></div>}
                  {b.type === "footer" && <div className="grid gap-1"><Input value={b.text} onChange={(e) => update(i, { text: e.target.value })} placeholder="פרטי העסק" /><Input value={b.unsubscribeText} onChange={(e) => update(i, { unsubscribeText: e.target.value })} /></div>}
                </div>
              ))}
              <div className="flex flex-wrap gap-1">{(Object.keys(BLOCK_LABEL) as EmailBlock["type"][]).map((t) => <Button key={t} variant="outline" size="sm" onClick={() => setDesign({ ...design, blocks: [...design.blocks, newBlock(t)] })}>+ {BLOCK_LABEL[t]}</Button>)}</div>
            </div>
            {problems.length > 0 && <ul className="text-xs text-destructive list-disc pe-4">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
          </div>
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">תצוגה מקדימה (נמען לדוגמה, רוחב מובייל/דסקטופ)</p>
            <iframe title="preview" className="h-[520px] w-full rounded-lg border bg-white" srcDoc={html} sandbox="" />
          </div>
        </div>
        <div className="mt-3 flex justify-end gap-2"><Button variant="ghost" onClick={() => setOpen(false)}>ביטול</Button><Button onClick={save} disabled={busy || !name.trim() || !subject.trim() || problems.length > 0}>שמור</Button></div>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteTemplateButton({ channel, id }: { channel: string; id: string }) {
  const router = useRouter();
  return <Button variant="ghost" size="sm" onClick={async () => { if (!confirm("למחוק את התבנית?")) return; try { await api.delete(`/api/channels/${channel}/templates`, { id }); toast.success("נמחקה"); router.refresh(); } catch (e) { toast.error((e as Error).message); } }}>מחק</Button>;
}
