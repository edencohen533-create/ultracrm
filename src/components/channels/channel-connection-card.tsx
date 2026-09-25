"use client";

/**
 * Provider connection for SMS (Telnyx / simulation) or email (Resend / simulation).
 * Secrets are write-only: the server returns masked values. Saving runs the provider check and
 * the badge reflects the real result – a stored key alone never shows "מחובר".
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Ltr } from "@/components/shared/ltr";

export interface CredentialView {
  id: string; channel: "sms" | "email"; provider: string; label: string | null; isActive: boolean; status: string; sendingBlocked: boolean; simulated: boolean;
  lastCheckedAt: string | null; lastWebhookAt: string | null; lastOutboundTestAt: string | null; lastConnectionError: string | null;
  senderName: string | null; senderEmail: string | null; replyTo: string | null; domainName: string | null; domainId?: string | null; domainStatus: string | null; domainRecords: Array<{ record: string; type: string; name: string; value: string; status?: string; required: boolean; priority?: number }> | null; domainCheckedAt: string | null;
  senders: Array<{ id: string; type: "number" | "alphanumeric"; value: string; inbound: boolean; label?: string }> | null; capabilities: Record<string, boolean> | null; testRecipients: string[] | null; unitPrice: number | null; unitPriceCurrency: string | null;
  config: { apiKeyMasked: string | null; messagingProfileId: string | null; publicKeyMasked: string | null; webhookSecretMasked: string | null }; webhookUrl: string;
}
interface Report { ok: boolean; checks: Array<{ label: string; ok: boolean; detail?: string }>; error?: string }
interface Template { id: string; name: string; channel: string }

const STATUS: Record<string, { label: string; cls: string }> = {
  disconnected: { label: "לא מחובר", cls: "" }, connected: { label: "מחובר ופעיל", cls: "bg-emerald-600 text-white" }, connected_not_ready: { label: "מחובר – לא מוכן", cls: "bg-amber-100 text-amber-900" }, error: { label: "שגיאת חיבור", cls: "bg-destructive text-white" }, in_progress: { label: "בתהליך", cls: "" }, needs_action: { label: "נדרשת פעולה", cls: "bg-amber-500 text-black" }, revoked: { label: "בוטל", cls: "bg-destructive text-white" },
};
const fmt = (v: string | null) => (v ? new Date(v).toLocaleString("he-IL") : "—");

export function ChannelConnectionCard({ channel, initial, templates, isOwner }: { channel: "sms" | "email"; initial: CredentialView | null; templates: Template[]; isOwner: boolean }) {
  const router = useRouter();
  const [c, setC] = useState<CredentialView | null>(initial);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [provider, setProvider] = useState(initial?.provider ?? (channel === "sms" ? "telnyx_sms" : "resend"));
  const [f, setF] = useState({ label: initial?.label ?? "", apiKey: "", messagingProfileId: initial?.config.messagingProfileId ?? "", publicKey: "", webhookSecret: "", senderName: initial?.senderName ?? "", senderEmail: initial?.senderEmail ?? "", replyTo: initial?.replyTo ?? "", testRecipients: (initial?.testRecipients ?? []).join(", "), unitPrice: initial?.unitPrice?.toString() ?? "", unitPriceCurrency: initial?.unitPriceCurrency ?? "USD", alphaSenders: (initial?.senders ?? []).filter((s) => s.type === "alphanumeric").map((s) => s.value).join(", ") });
  const [domain, setDomain] = useState(initial?.domainName ?? "");
  const [testTo, setTestTo] = useState("");
  const [testTemplate, setTestTemplate] = useState(templates[0]?.id ?? "");
  useEffect(() => { if (!testTemplate && templates[0]) setTestTemplate(templates[0].id); }, [templates, testTemplate]);

  async function refresh() { const r = await api.get<{ items: CredentialView[] }>(`/api/channels/${channel}`); setC(r.items.find((x) => x.isActive) ?? null); router.refresh(); }
  async function save() {
    setBusy("save");
    try {
      const body: Record<string, unknown> = { provider, label: f.label || undefined, testRecipients: f.testRecipients.split(/[,\n]/).map((s) => s.trim()).filter(Boolean), unitPrice: f.unitPrice ? Number(f.unitPrice) : null, unitPriceCurrency: f.unitPriceCurrency || undefined };
      if (f.apiKey) body.apiKey = f.apiKey;
      if (channel === "sms") { body.messagingProfileId = f.messagingProfileId; if (f.publicKey) body.publicKey = f.publicKey; body.senders = f.alphaSenders.split(/[,\n]/).map((s) => s.trim()).filter(Boolean).map((value) => ({ value, type: "alphanumeric", inbound: false })); }
      else { body.senderName = f.senderName; body.senderEmail = f.senderEmail; body.replyTo = f.replyTo || null; if (f.webhookSecret) body.webhookSecret = f.webhookSecret; }
      const r = await api.post<{ credential: CredentialView; report: Report }>(`/api/channels/${channel}`, body);
      setC(r.credential); setReport(r.report); setF({ ...f, apiKey: "", publicKey: "", webhookSecret: "" });
      if (r.report.ok) toast.success("החיבור נשמר ונבדק בהצלחה"); else toast.warning("החיבור נשמר אך הבדיקה נכשלה – ראו פירוט");
      router.refresh();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  async function act(action: "check" | "disconnect" | "connect_domain" | "verify_domain") {
    if (!c) return;
    if (action === "disconnect" && !confirm("לנתק את הספק? קמפיינים חדשים בערוץ לא יישלחו עד לחיבור מחדש. ההיסטוריה נשמרת.")) return;
    setBusy(action);
    try {
      const r = await api.post<{ credential?: CredentialView; report?: Report } & CredentialView>(`/api/channels/${channel}/${c.id}`, { action, domain, confirm: true });
      if (action === "check") { setC(r.credential!); setReport(r.report!); if (r.report!.ok) toast.success("החיבור תקין"); else toast.warning(r.report!.error ?? "הבדיקה נכשלה"); }
      else { setC(action === "disconnect" ? null : (r as CredentialView)); if (action === "disconnect") toast.success("הספק נותק"); else toast.success(`מצב הדומיין: ${(r as CredentialView).domainStatus}`); }
      router.refresh();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  async function test() {
    if (!c) return;
    setBusy("test");
    try {
      const r = await api.post<{ providerMessageId: string; simulated: boolean; segments: number | null }>(`/api/channels/${channel}/test`, { templateId: testTemplate, to: testTo });
      toast.success(`${r.simulated ? "הדמיה: " : ""}הודעת בדיקה נשלחה (${r.providerMessageId})${r.segments ? ` · ${r.segments} מקטעים` : ""}`);
      await refresh();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }

  const st = c ? STATUS[c.status] ?? STATUS.disconnected : STATUS.disconnected;
  return (
    <div className="space-y-5">
      <section className="rounded-xl border bg-card p-5 shadow-sm" data-testid={`${channel}-connection`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">{channel === "sms" ? "SMS" : "אימייל"} – ספק שליחה</h2>
          <div className="flex items-center gap-2">
            {c?.simulated && <Badge variant="outline">הדמיה</Badge>}
            <Badge className={st.cls} variant={c ? "default" : "outline"} data-testid={`${channel}-status`}>{c ? st.label : "לא מחובר"}</Badge>
          </div>
        </div>
        {c && (
          <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <div className="flex gap-2"><dt className="text-muted-foreground">ספק:</dt><dd>{c.provider}</dd></div>
            <div className="flex gap-2"><dt className="text-muted-foreground">נבדק:</dt><dd>{fmt(c.lastCheckedAt)}</dd></div>
            <div className="flex gap-2"><dt className="text-muted-foreground">אירוע אחרון מהספק:</dt><dd>{fmt(c.lastWebhookAt)}</dd></div>
            <div className="flex gap-2"><dt className="text-muted-foreground">בדיקת שליחה אחרונה:</dt><dd>{fmt(c.lastOutboundTestAt)}</dd></div>
            {channel === "sms" && <div className="flex gap-2 sm:col-span-2"><dt className="text-muted-foreground">שולחים מאושרים:</dt><dd>{c.senders?.length ? c.senders.map((s) => <span key={s.value} className="me-2"><Ltr>{s.value}</Ltr>{s.inbound ? " (קולט תשובות)" : " (ללא תשובות)"}</span>) : "אין – שייך מספר לפרופיל או הוסף שולח אלפאנומרי מאושר"}</dd></div>}
            {channel === "email" && <div className="flex gap-2 sm:col-span-2"><dt className="text-muted-foreground">שולח:</dt><dd>{c.senderName} &lt;<Ltr>{c.senderEmail ?? ""}</Ltr>&gt;{c.replyTo ? ` · Reply-To: ${c.replyTo}` : ""}</dd></div>}
            <div className="flex gap-2 sm:col-span-2"><dt className="text-muted-foreground">Webhook URL להגדרה אצל הספק:</dt><dd><Ltr><code className="text-xs">{c.webhookUrl}</code></Ltr></dd></div>
          </dl>
        )}
        {c?.lastConnectionError && <p className="mt-2 text-sm text-destructive" data-testid={`${channel}-error`}>{c.lastConnectionError}</p>}
        {report && <ul className="mt-3 space-y-1 text-sm">{report.checks.map((k) => <li key={k.label}>{k.ok ? "✅" : "❌"} {k.label}{k.detail ? <span className="text-muted-foreground"> – {k.detail}</span> : null}</li>)}</ul>}
        {c && (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => act("check")} disabled={busy !== null} data-testid={`${channel}-check`}>{busy === "check" ? "בודק…" : "בדוק חיבור"}</Button>
            {isOwner && <Button variant="destructive" size="sm" onClick={() => act("disconnect")} disabled={busy !== null}>נתק</Button>}
          </div>
        )}
      </section>

      {channel === "email" && c && (
        <section className="rounded-xl border bg-card p-5 shadow-sm">
          <h3 className="font-semibold">דומיין שולח ואימות (SPF / DKIM / DMARC)</h3>
          <p className="mt-1 text-sm text-muted-foreground">הרשומות מוצגות מהספק; יש להוסיף אותן ב-DNS של הדומיין ידנית. המערכת אינה משנה DNS. שליחה אמיתית נחסמת עד שהדומיין מאומת.</p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div><Label htmlFor="domain">דומיין</Label><Input id="domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" dir="ltr" className="w-64" disabled={!isOwner} /></div>
            {isOwner && <Button size="sm" onClick={() => act("connect_domain")} disabled={busy !== null || !domain}>{c.domainId ? "רענן רשומות" : "חבר דומיין"}</Button>}
            {c.domainId && <Button size="sm" variant="outline" onClick={() => act("verify_domain")} disabled={busy !== null}>{busy === "verify_domain" ? "מאמת…" : "אמת עכשיו"}</Button>}
            {c.domainName && <Badge variant={c.domainStatus === "verified" ? "default" : "outline"} className={c.domainStatus === "verified" ? "bg-emerald-600 text-white" : ""}>{c.domainName}: {c.domainStatus ?? "—"}</Badge>}
          </div>
          {c.domainRecords && c.domainRecords.length > 0 && (
            <div className="mt-3 overflow-auto"><table className="w-full text-xs"><thead><tr className="text-muted-foreground"><th className="p-1 text-start">רשומה</th><th className="p-1 text-start">סוג</th><th className="p-1 text-start">שם</th><th className="p-1 text-start">ערך</th><th className="p-1 text-start">מצב</th></tr></thead>
              <tbody>{c.domainRecords.map((r, i) => <tr key={i} className="border-t"><td className="p-1">{r.record}{!r.required && <span className="text-muted-foreground"> (מומלץ)</span>}</td><td className="p-1">{r.type}{r.priority ? ` (${r.priority})` : ""}</td><td className="p-1"><Ltr><code>{r.name}</code></Ltr></td><td className="p-1 break-all"><Ltr><code>{r.value}</code></Ltr></td><td className="p-1">{r.status ?? "—"}</td></tr>)}</tbody></table></div>
          )}
        </section>
      )}

      {isOwner && (
        <section className="rounded-xl border bg-card p-5 shadow-sm space-y-3">
          <h3 className="font-semibold">{c ? "עדכון פרטי החיבור" : "חיבור ספק"}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><Label>ספק</Label><select className="mt-1 w-full rounded-md border bg-background p-2 text-sm" value={provider} onChange={(e) => setProvider(e.target.value)}>{channel === "sms" ? <><option value="telnyx_sms">Telnyx Messaging</option><option value="mock_sms">הדמיה (ללא שליחה)</option></> : <><option value="resend">Resend</option><option value="mock_email">הדמיה (ללא שליחה)</option></>}</select></div>
            <div><Label>תווית</Label><Input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></div>
            {!provider.startsWith("mock") && <div><Label>API Key {c?.config.apiKeyMasked ? <span className="text-muted-foreground">(שמור: {c.config.apiKeyMasked})</span> : null}</Label><Input type="password" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} dir="ltr" placeholder={c?.config.apiKeyMasked ? "השאר ריק כדי לא לשנות" : ""} autoComplete="off" /></div>}
            {channel === "sms" && !provider.startsWith("mock") && <>
              <div><Label>Messaging Profile ID</Label><Input value={f.messagingProfileId} onChange={(e) => setF({ ...f, messagingProfileId: e.target.value })} dir="ltr" /></div>
              <div><Label>Public Key לאימות Webhooks {c?.config.publicKeyMasked ? <span className="text-muted-foreground">(שמור)</span> : null}</Label><Input type="password" value={f.publicKey} onChange={(e) => setF({ ...f, publicKey: e.target.value })} dir="ltr" autoComplete="off" /></div>
              <div className="sm:col-span-2"><Label>שולחים אלפאנומריים מאושרים (מופרדים בפסיק; ללא קליטת תשובות)</Label><Input value={f.alphaSenders} onChange={(e) => setF({ ...f, alphaSenders: e.target.value })} dir="ltr" placeholder="MyBrand" /></div>
            </>}
            {channel === "email" && <>
              <div><Label>שם שולח</Label><Input value={f.senderName} onChange={(e) => setF({ ...f, senderName: e.target.value })} /></div>
              <div><Label>כתובת שולח</Label><Input value={f.senderEmail} onChange={(e) => setF({ ...f, senderEmail: e.target.value })} dir="ltr" placeholder="news@example.com" /></div>
              <div><Label>Reply-To (אופציונלי)</Label><Input value={f.replyTo} onChange={(e) => setF({ ...f, replyTo: e.target.value })} dir="ltr" /></div>
              {!provider.startsWith("mock") && <div><Label>Webhook Signing Secret (whsec_…) {c?.config.webhookSecretMasked ? <span className="text-muted-foreground">(שמור)</span> : null}</Label><Input type="password" value={f.webhookSecret} onChange={(e) => setF({ ...f, webhookSecret: e.target.value })} dir="ltr" autoComplete="off" /></div>}
            </>}
            <div className="sm:col-span-2"><Label>נמעני בדיקה מורשים (מופרדים בפסיק) – שליחות בדיקה יוצאות רק אליהם</Label><Input value={f.testRecipients} onChange={(e) => setF({ ...f, testRecipients: e.target.value })} dir="ltr" placeholder={channel === "sms" ? "+972501234567" : "me@example.com"} /></div>
            <div><Label>מחיר ליחידה לאומדן ({channel === "sms" ? "למקטע" : "לאימייל"}; ריק = לא ידוע)</Label><Input value={f.unitPrice} onChange={(e) => setF({ ...f, unitPrice: e.target.value })} dir="ltr" type="number" step="0.0001" min="0" /></div>
            <div><Label>מטבע</Label><Input value={f.unitPriceCurrency} onChange={(e) => setF({ ...f, unitPriceCurrency: e.target.value.toUpperCase() })} dir="ltr" maxLength={3} /></div>
          </div>
          <p className="text-xs text-muted-foreground">המפתחות נשמרים מוצפנים בשרת בלבד ואינם מוחזרים לדפדפן. שמירה מריצה בדיקת חיבור מול הספק; רק תוצאה תקינה מסמנת &quot;מחובר&quot;.</p>
          <Button onClick={save} disabled={busy !== null || (channel === "email" && (!f.senderName || !f.senderEmail))} data-testid={`${channel}-save`}>{busy === "save" ? "שומר ובודק…" : "שמור ובדוק חיבור"}</Button>
        </section>
      )}

      {c && (
        <section className="rounded-xl border bg-card p-5 shadow-sm space-y-2">
          <h3 className="font-semibold">שליחת בדיקה</h3>
          <p className="text-xs text-muted-foreground">רק לנמעני הבדיקה שהוגדרו למעלה: {(c.testRecipients ?? []).length ? c.testRecipients!.map((t) => <Ltr key={t}><code className="me-1">{t}</code></Ltr>) : "לא הוגדרו"}</p>
          <div className="flex flex-wrap items-end gap-2">
            <div><Label>תבנית</Label><select className="mt-1 rounded-md border bg-background p-2 text-sm" value={testTemplate} onChange={(e) => setTestTemplate(e.target.value)}>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
            <div><Label>נמען בדיקה</Label><Input value={testTo} onChange={(e) => setTestTo(e.target.value)} dir="ltr" className="w-56" /></div>
            <Button variant="secondary" onClick={test} disabled={busy !== null || !testTo || !testTemplate} data-testid={`${channel}-test`}>{busy === "test" ? "שולח…" : "שלח בדיקה"}</Button>
          </div>
          {!templates.length && <p className="text-xs text-amber-700">אין תבניות {channel === "sms" ? "SMS" : "אימייל"} עדיין – צור תבנית במסך התבניות.</p>}
        </section>
      )}
    </div>
  );
}
