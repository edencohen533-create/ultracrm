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
import { useT } from "@/components/i18n/LangProvider";

export interface CredentialView {
  id: string; channel: "sms" | "email"; provider: string; label: string | null; isActive: boolean; status: string; sendingBlocked: boolean; simulated: boolean;
  lastCheckedAt: string | null; lastWebhookAt: string | null; lastOutboundTestAt: string | null; lastConnectionError: string | null;
  senderName: string | null; senderEmail: string | null; replyTo: string | null; domainName: string | null; domainId?: string | null; domainStatus: string | null; domainRecords: Array<{ record: string; type: string; name: string; value: string; status?: string; required: boolean; priority?: number }> | null; domainCheckedAt: string | null;
  senders: Array<{ id: string; type: "number" | "alphanumeric"; value: string; inbound: boolean; label?: string }> | null; capabilities: Record<string, boolean> | null; testRecipients: string[] | null; unitPrice: number | null; unitPriceCurrency: string | null;
  config: { apiKeyMasked: string | null; messagingProfileId: string | null; publicKeyMasked: string | null; webhookSecretMasked: string | null }; webhookUrl: string;
}
interface Report { ok: boolean; checks: Array<{ label: string; ok: boolean; detail?: string }>; error?: string }
interface Template { id: string; name: string; channel: string }

const STATUS: Record<string, { label: string; en: string; cls: string }> = {
  disconnected: { label: "לא מחובר", en: "Not connected", cls: "" }, connected: { label: "מחובר ופעיל", en: "Connected and active", cls: "bg-emerald-600 text-white" }, connected_not_ready: { label: "מחובר – לא מוכן", en: "Connected – not ready", cls: "bg-amber-100 text-amber-900" }, error: { label: "שגיאת חיבור", en: "Connection error", cls: "bg-destructive text-white" }, in_progress: { label: "בתהליך", en: "In progress", cls: "" }, needs_action: { label: "נדרשת פעולה", en: "Action required", cls: "bg-amber-500 text-black" }, revoked: { label: "בוטל", en: "Revoked", cls: "bg-destructive text-white" },
};
const fmtDate = (v: string | null, locale: string) => (v ? new Date(v).toLocaleString(locale) : "—");

export function ChannelConnectionCard({ channel, initial, templates, isOwner }: { channel: "sms" | "email"; initial: CredentialView | null; templates: Template[]; isOwner: boolean }) {
  const t = useT();
  const fmt = (v: string | null) => fmtDate(v, t.lang === "en" ? "en-GB" : "he-IL");
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
      if (r.report.ok) toast.success(t("החיבור נשמר ונבדק בהצלחה", "Connection saved and verified")); else toast.warning(t("החיבור נשמר אך הבדיקה נכשלה – ראו פירוט", "Connection saved but the check failed – see details"));
      router.refresh();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  async function act(action: "check" | "disconnect" | "connect_domain" | "verify_domain") {
    if (!c) return;
    if (action === "disconnect" && !confirm(t("לנתק את הספק? קמפיינים חדשים בערוץ לא יישלחו עד לחיבור מחדש. ההיסטוריה נשמרת.", "Disconnect the provider? New campaigns on this channel won't be sent until you reconnect. History is kept."))) return;
    setBusy(action);
    try {
      const r = await api.post<{ credential?: CredentialView; report?: Report } & CredentialView>(`/api/channels/${channel}/${c.id}`, { action, domain, confirm: true });
      if (action === "check") { setC(r.credential!); setReport(r.report!); if (r.report!.ok) toast.success(t("החיבור תקין", "Connection OK")); else toast.warning(r.report!.error ?? t("הבדיקה נכשלה", "Check failed")); }
      else { setC(action === "disconnect" ? null : (r as CredentialView)); if (action === "disconnect") toast.success(t("הספק נותק", "Provider disconnected")); else toast.success(t(`מצב הדומיין: ${(r as CredentialView).domainStatus}`, `Domain status: ${(r as CredentialView).domainStatus}`)); }
      router.refresh();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  async function test() {
    if (!c) return;
    setBusy("test");
    try {
      const r = await api.post<{ providerMessageId: string; simulated: boolean; segments: number | null }>(`/api/channels/${channel}/test`, { templateId: testTemplate, to: testTo });
      toast.success(t(`${r.simulated ? "הדמיה: " : ""}הודעת בדיקה נשלחה (${r.providerMessageId})${r.segments ? ` · ${r.segments} מקטעים` : ""}`, `${r.simulated ? "Simulation: " : ""}Test message sent (${r.providerMessageId})${r.segments ? ` · ${r.segments} segments` : ""}`));
      await refresh();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }

  const st = c ? STATUS[c.status] ?? STATUS.disconnected : STATUS.disconnected;
  return (
    <div className="space-y-5">
      <section className="rounded-xl border bg-card p-5 shadow-sm" data-testid={`${channel}-connection`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">{channel === "sms" ? "SMS" : t("אימייל", "Email")} – {t("ספק שליחה", "sending provider")}</h2>
          <div className="flex items-center gap-2">
            {c?.simulated && <Badge variant="outline">{t("הדמיה", "Simulation")}</Badge>}
            <Badge className={st.cls} variant={c ? "default" : "outline"} data-testid={`${channel}-status`}>{c ? t(st.label, st.en) : t("לא מחובר", "Not connected")}</Badge>
          </div>
        </div>
        {c && (
          <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <div className="flex gap-2"><dt className="text-muted-foreground">{t("ספק:", "Provider:")}</dt><dd>{c.provider}</dd></div>
            <div className="flex gap-2"><dt className="text-muted-foreground">{t("נבדק:", "Checked:")}</dt><dd>{fmt(c.lastCheckedAt)}</dd></div>
            <div className="flex gap-2"><dt className="text-muted-foreground">{t("אירוע אחרון מהספק:", "Last provider event:")}</dt><dd>{fmt(c.lastWebhookAt)}</dd></div>
            <div className="flex gap-2"><dt className="text-muted-foreground">{t("בדיקת שליחה אחרונה:", "Last test send:")}</dt><dd>{fmt(c.lastOutboundTestAt)}</dd></div>
            {channel === "sms" && <div className="flex gap-2 sm:col-span-2"><dt className="text-muted-foreground">{t("שולחים מאושרים:", "Approved senders:")}</dt><dd>{c.senders?.length ? c.senders.map((s) => <span key={s.value} className="me-2"><Ltr>{s.value}</Ltr>{s.inbound ? t(" (קולט תשובות)", " (receives replies)") : t(" (ללא תשובות)", " (no replies)")}</span>) : t("אין – שייך מספר לפרופיל או הוסף שולח אלפאנומרי מאושר", "None – assign a number to the profile or add an approved alphanumeric sender")}</dd></div>}
            {channel === "email" && <div className="flex gap-2 sm:col-span-2"><dt className="text-muted-foreground">{t("שולח:", "Sender:")}</dt><dd>{c.senderName} &lt;<Ltr>{c.senderEmail ?? ""}</Ltr>&gt;{c.replyTo ? ` · Reply-To: ${c.replyTo}` : ""}</dd></div>}
            <div className="flex flex-wrap gap-x-2 sm:col-span-2"><dt className="text-muted-foreground">{t("Webhook URL להגדרה אצל הספק:", "Webhook URL to configure at the provider:")}</dt><dd className="min-w-0 max-w-full"><Ltr className="max-w-full break-all"><code className="text-xs">{c.webhookUrl}</code></Ltr></dd></div>
          </dl>
        )}
        {c?.lastConnectionError && <p className="mt-2 text-sm text-destructive" data-testid={`${channel}-error`}>{c.lastConnectionError}</p>}
        {report && <ul className="mt-3 space-y-1 text-sm">{report.checks.map((k) => <li key={k.label}>{k.ok ? "✅" : "❌"} {k.label}{k.detail ? <span className="text-muted-foreground"> – {k.detail}</span> : null}</li>)}</ul>}
        {c && (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => act("check")} disabled={busy !== null} data-testid={`${channel}-check`}>{busy === "check" ? t("בודק…", "Checking…") : t("בדוק חיבור", "Test connection")}</Button>
            {isOwner && <Button variant="destructive" size="sm" onClick={() => act("disconnect")} disabled={busy !== null}>{t("נתק", "Disconnect")}</Button>}
          </div>
        )}
      </section>

      {channel === "email" && c && (
        <section className="rounded-xl border bg-card p-5 shadow-sm">
          <h3 className="font-semibold">{t("דומיין שולח ואימות (SPF / DKIM / DMARC)", "Sending domain & authentication (SPF / DKIM / DMARC)")}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t("הרשומות מוצגות מהספק; יש להוסיף אותן ב-DNS של הדומיין ידנית. המערכת אינה משנה DNS. שליחה אמיתית נחסמת עד שהדומיין מאומת.", "Records are shown from the provider; add them to your domain's DNS manually. The system never changes DNS. Real sending is blocked until the domain is verified.")}</p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="min-w-0 max-w-full"><Label htmlFor="domain">{t("דומיין", "Domain")}</Label><Input id="domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" dir="ltr" className="w-full sm:w-64" disabled={!isOwner} /></div>
            {isOwner && <Button size="sm" onClick={() => act("connect_domain")} disabled={busy !== null || !domain}>{c.domainId ? t("רענן רשומות", "Refresh records") : t("חבר דומיין", "Connect domain")}</Button>}
            {c.domainId && <Button size="sm" variant="outline" onClick={() => act("verify_domain")} disabled={busy !== null}>{busy === "verify_domain" ? t("מאמת…", "Verifying…") : t("אמת עכשיו", "Verify now")}</Button>}
            {c.domainName && <Badge variant={c.domainStatus === "verified" ? "default" : "outline"} className={c.domainStatus === "verified" ? "bg-emerald-600 text-white" : ""}>{c.domainName}: {c.domainStatus ?? "—"}</Badge>}
          </div>
          {c.domainRecords && c.domainRecords.length > 0 && (
            <div className="mt-3 overflow-auto"><table className="w-full text-xs"><thead><tr className="text-muted-foreground"><th className="p-1 text-start">{t("רשומה", "Record")}</th><th className="p-1 text-start">{t("סוג", "Type")}</th><th className="p-1 text-start">{t("שם", "Name")}</th><th className="p-1 text-start">{t("ערך", "Value")}</th><th className="p-1 text-start">{t("מצב", "Status")}</th></tr></thead>
              <tbody>{c.domainRecords.map((r, i) => <tr key={i} className="border-t"><td className="p-1">{r.record}{!r.required && <span className="text-muted-foreground">{t(" (מומלץ)", " (recommended)")}</span>}</td><td className="p-1">{r.type}{r.priority ? ` (${r.priority})` : ""}</td><td className="p-1"><Ltr><code>{r.name}</code></Ltr></td><td className="p-1 break-all"><Ltr><code>{r.value}</code></Ltr></td><td className="p-1">{r.status ?? "—"}</td></tr>)}</tbody></table></div>
          )}
        </section>
      )}

      {isOwner && (
        <section className="rounded-xl border bg-card p-5 shadow-sm space-y-3">
          <h3 className="font-semibold">{c ? t("עדכון פרטי החיבור", "Update connection details") : t("חיבור ספק", "Connect provider")}</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div><Label>{t("ספק", "Provider")}</Label><select className="mt-1 w-full rounded-md border bg-background p-2 text-sm" value={provider} onChange={(e) => setProvider(e.target.value)}>{channel === "sms" ? <><option value="telnyx_sms">Telnyx Messaging</option><option value="mock_sms">{t("הדמיה (ללא שליחה)", "Simulation (no sending)")}</option></> : <><option value="resend">Resend</option><option value="mock_email">{t("הדמיה (ללא שליחה)", "Simulation (no sending)")}</option></>}</select></div>
            <div><Label>{t("תווית", "Label")}</Label><Input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></div>
            {!provider.startsWith("mock") && <div><Label>API Key {c?.config.apiKeyMasked ? <span className="text-muted-foreground">({t("שמור:", "saved:")} {c.config.apiKeyMasked})</span> : null}</Label><Input type="password" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} dir="ltr" placeholder={c?.config.apiKeyMasked ? t("השאר ריק כדי לא לשנות", "Leave blank to keep unchanged") : ""} autoComplete="off" /></div>}
            {channel === "sms" && !provider.startsWith("mock") && <>
              <div><Label>Messaging Profile ID</Label><Input value={f.messagingProfileId} onChange={(e) => setF({ ...f, messagingProfileId: e.target.value })} dir="ltr" /></div>
              <div><Label>{t("Public Key לאימות Webhooks", "Public Key for webhook verification")} {c?.config.publicKeyMasked ? <span className="text-muted-foreground">{t("(שמור)", "(saved)")}</span> : null}</Label><Input type="password" value={f.publicKey} onChange={(e) => setF({ ...f, publicKey: e.target.value })} dir="ltr" autoComplete="off" /></div>
              <div className="sm:col-span-2"><Label>{t("שולחים אלפאנומריים מאושרים (מופרדים בפסיק; ללא קליטת תשובות)", "Approved alphanumeric senders (comma-separated; cannot receive replies)")}</Label><Input value={f.alphaSenders} onChange={(e) => setF({ ...f, alphaSenders: e.target.value })} dir="ltr" placeholder="MyBrand" /></div>
            </>}
            {channel === "email" && <>
              <div><Label>{t("שם שולח", "Sender name")}</Label><Input value={f.senderName} onChange={(e) => setF({ ...f, senderName: e.target.value })} /></div>
              <div><Label>{t("כתובת שולח", "Sender address")}</Label><Input value={f.senderEmail} onChange={(e) => setF({ ...f, senderEmail: e.target.value })} dir="ltr" placeholder="news@example.com" /></div>
              <div><Label>{t("Reply-To (אופציונלי)", "Reply-To (optional)")}</Label><Input value={f.replyTo} onChange={(e) => setF({ ...f, replyTo: e.target.value })} dir="ltr" /></div>
              {!provider.startsWith("mock") && <div><Label>Webhook Signing Secret (whsec_…) {c?.config.webhookSecretMasked ? <span className="text-muted-foreground">{t("(שמור)", "(saved)")}</span> : null}</Label><Input type="password" value={f.webhookSecret} onChange={(e) => setF({ ...f, webhookSecret: e.target.value })} dir="ltr" autoComplete="off" /></div>}
            </>}
            <div className="sm:col-span-2"><Label>{t("נמעני בדיקה מורשים (מופרדים בפסיק) – שליחות בדיקה יוצאות רק אליהם", "Allowed test recipients (comma-separated) – test sends go only to them")}</Label><Input value={f.testRecipients} onChange={(e) => setF({ ...f, testRecipients: e.target.value })} dir="ltr" placeholder={channel === "sms" ? "+972501234567" : "me@example.com"} /></div>
            <div><Label>{t(`מחיר ליחידה לאומדן (${channel === "sms" ? "למקטע" : "לאימייל"}; ריק = לא ידוע)`, `Unit price for estimates (${channel === "sms" ? "per segment" : "per email"}; blank = unknown)`)}</Label><Input value={f.unitPrice} onChange={(e) => setF({ ...f, unitPrice: e.target.value })} dir="ltr" type="number" step="0.0001" min="0" /></div>
            <div><Label>{t("מטבע", "Currency")}</Label><Input value={f.unitPriceCurrency} onChange={(e) => setF({ ...f, unitPriceCurrency: e.target.value.toUpperCase() })} dir="ltr" maxLength={3} /></div>
          </div>
          <p className="text-xs text-muted-foreground">{t("המפתחות נשמרים מוצפנים בשרת בלבד ואינם מוחזרים לדפדפן. שמירה מריצה בדיקת חיבור מול הספק; רק תוצאה תקינה מסמנת \"מחובר\".", "Keys are stored encrypted on the server only and are never returned to the browser. Saving runs a connection check with the provider; only a successful result marks it \"Connected\".")}</p>
          <Button onClick={save} disabled={busy !== null || (channel === "email" && (!f.senderName || !f.senderEmail))} data-testid={`${channel}-save`}>{busy === "save" ? t("שומר ובודק…", "Saving and checking…") : t("שמור ובדוק חיבור", "Save and test connection")}</Button>
        </section>
      )}

      {c && (
        <section className="rounded-xl border bg-card p-5 shadow-sm space-y-2">
          <h3 className="font-semibold">{t("שליחת בדיקה", "Test send")}</h3>
          <p className="text-xs text-muted-foreground">{t("רק לנמעני הבדיקה שהוגדרו למעלה:", "Only to the test recipients defined above:")} {(c.testRecipients ?? []).length ? c.testRecipients!.map((rcpt) => <Ltr key={rcpt}><code className="me-1">{rcpt}</code></Ltr>) : t("לא הוגדרו", "none defined")}</p>
          <div className="flex flex-wrap items-end gap-2">
            <div><Label>{t("תבנית", "Template")}</Label><select className="mt-1 rounded-md border bg-background p-2 text-sm" value={testTemplate} onChange={(e) => setTestTemplate(e.target.value)}>{templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}</select></div>
            <div className="min-w-0 max-w-full"><Label>{t("נמען בדיקה", "Test recipient")}</Label><Input value={testTo} onChange={(e) => setTestTo(e.target.value)} dir="ltr" className="w-full sm:w-56" /></div>
            <Button variant="secondary" onClick={test} disabled={busy !== null || !testTo || !testTemplate} data-testid={`${channel}-test`}>{busy === "test" ? t("שולח…", "Sending…") : t("שלח בדיקה", "Send test")}</Button>
          </div>
          {!templates.length && <p className="text-xs text-amber-700">{t(`אין תבניות ${channel === "sms" ? "SMS" : "אימייל"} עדיין – צור תבנית במסך התבניות.`, `No ${channel === "sms" ? "SMS" : "email"} templates yet – create one on the templates screen.`)}</p>}
        </section>
      )}
    </div>
  );
}
