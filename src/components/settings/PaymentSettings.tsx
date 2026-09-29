"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Input, Panel, Select } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";
import { useMe } from "@/lib/client/use-me";

type Summary = { connected: false } | { connected: true; id: string; provider: string; environment: string; label: string | null; webhookUrl: string; lastError: string | null };

/** "תשלומים": the business's card-payment provider. Owner connects; keys are stored encrypted and never shown again. */
export function PaymentSettings() {
  const t = useT();
  const isOwner = useMe()?.user.role === "owner";
  const [s, setS] = useState<Summary | null>(null);
  const [form, setForm] = useState({ provider: "payplus" as "payplus" | "sandbox", environment: "test" as "test" | "live", apiKey: "", secretKey: "", paymentPageUid: "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get<Summary>("/api/settings/payments").then(setS).catch(() => setS({ connected: false })); }, []);
  async function connect() {
    setBusy(true);
    try { setS(await api.post<Summary>("/api/settings/payments", form)); setForm((f) => ({ ...f, apiKey: "", secretKey: "" })); toast.success(t("ספק הסליקה חובר", "Payment provider connected")); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  async function disconnect() {
    if (!confirm(t("לנתק את ספק הסליקה? לא יהיה אפשר לגבות עד חיבור מחדש.", "Disconnect the payment provider? Payments won't be possible until reconnected."))) return;
    setBusy(true);
    try { setS(await api.delete<Summary>("/api/settings/payments")); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Panel title={t("תשלומים – ספק סליקה", "Payments – card provider")}>
      <div className="space-y-3 text-sm" data-testid="payment-settings">
        {s?.connected ? (
          <div className="flex flex-wrap items-center gap-2">
            <b>{s.provider === "payplus" ? "PayPlus" : t("ספק בדיקה (ללא חיוב)", "Sandbox (no charges)")}</b>
            <Badge tone={s.environment === "live" ? "good" : "warn"}>{s.environment === "live" ? t("סביבה חיה", "Live") : t("סביבת בדיקה", "Test")}</Badge>
            {isOwner && <Button size="sm" variant="ghost" className="ms-auto" onClick={disconnect} disabled={busy}>{t("נתק", "Disconnect")}</Button>}
            {s.provider === "payplus" && <p className="basis-full text-xs text-muted">{t("כתובת העדכונים (נשלחת ל-PayPlus אוטומטית עם כל עמוד תשלום):", "Notification URL (sent to PayPlus automatically with every payment page):")} <span dir="ltr" className="font-mono">{s.webhookUrl}</span></p>}
          </div>
        ) : <p className="text-muted">{t("לא חובר ספק סליקה – לא ניתן לגבות בשיחה.", "No payment provider – payments during calls are not available.")}</p>}
        <p className="text-xs text-muted">{t("פרטי כרטיס אשראי לעולם אינם עוברים דרך UltraCRM: התשלום מתבצע בעמוד התשלום המאובטח של הספק (בתוך מסך השיחה או בקישור ללקוח).", "Card details never pass through UltraCRM: payment happens on the provider's secure page (inside the call screen or via a link to the customer).")}</p>
        {isOwner && (
          <div className="grid gap-2 sm:grid-cols-2">
            <Select label={t("ספק", "Provider")} value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value as "payplus" | "sandbox", environment: "test" })} data-testid="pay-provider">
              <option value="payplus">PayPlus</option><option value="sandbox">{t("ספק בדיקה (ללא חיוב)", "Sandbox (no charges)")}</option>
            </Select>
            <Select label={t("סביבה", "Environment")} value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value as "test" | "live" })} disabled={form.provider === "sandbox"}>
              <option value="test">{t("בדיקה", "Test")}</option><option value="live">{t("חיה (חיובים אמיתיים)", "Live (real charges)")}</option>
            </Select>
            {form.provider === "payplus" && <>
              <Input label="API key" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} ltr autoComplete="off" />
              <Input label="Secret key" type="password" value={form.secretKey} onChange={(e) => setForm({ ...form, secretKey: e.target.value })} ltr autoComplete="off" />
              <Input label="Payment page UID" value={form.paymentPageUid} onChange={(e) => setForm({ ...form, paymentPageUid: e.target.value })} ltr autoComplete="off" />
            </>}
            <div className="flex items-end"><Button onClick={connect} loading={busy} data-testid="pay-connect">{s?.connected ? t("החלף חיבור", "Replace connection") : t("חבר", "Connect")}</Button></div>
          </div>
        )}
      </div>
    </Panel>
  );
}
