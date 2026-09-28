"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Ltr } from "@/components/shared/ltr";
import { useT } from "@/components/i18n/LangProvider";

interface Summary {
  id?: string;
  provider: string;
  lastCheckedAt?: string | null;
  lastConnectionError?: string | null;
  sendingBlocked?: boolean;
  phoneNumberId?: string | null;
  businessAccountId?: string | null;
  accessTokenMasked?: string | null;
  hasAppSecret?: boolean;
}

/** Disconnect reasons stored in Hebrew by the Meta callbacks (meta-deletion-service). */
const META_REASON_EN: Record<string, string> = { "Meta: בקשת מחיקת נתונים": "Meta: data deletion request", "Meta: האפליקציה הוסרה על ידי המשתמש": "Meta: the app was removed by the user" };
interface NumberSummary { id: string; label: string | null; displayPhoneNumber: string | null; phoneNumberId: string | null; teamId: string | null; isActive: boolean; isDefault: boolean; sendingBlocked: boolean; lastCheckedAt: string | null; lastWebhookAt: string | null; lastConnectionError: string | null }
export function WhatsAppProviderForm({ initialSummary, webhookUrl, numbers = [], teams = [] }: { initialSummary: Summary; webhookUrl: string; numbers?: NumberSummary[]; teams?: { id: string; name: string }[] }) {
  const t = useT();
  const locale = t.lang === "en" ? "en-GB" : "he-IL";
  const router = useRouter();
  const summary = initialSummary;
  const [label, setLabel] = useState("");
  const [teamId, setTeamId] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);
  const [businessAccountId, setBusinessAccountId] = useState(initialSummary.businessAccountId ?? "");
  const [accessToken, setAccessToken] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState(initialSummary.phoneNumberId ?? "");
  const [webhookVerifyToken, setWebhookVerifyToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [isSwitching, setIsSwitching] = useState(false);

  const isMetaActive = summary.provider === "meta_whatsapp_cloud_api";

  async function handleActivateMeta() {
    setIsSubmitting(true);
    try {
      const res = await fetch("/api/settings/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, teamId: teamId || null, makeDefault, accessToken, phoneNumberId, businessAccountId: businessAccountId || undefined, webhookVerifyToken, appSecret: appSecret || undefined }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast.error(typeof data?.error === "string" ? data.error : t("שגיאה בהפעלת החיבור", "Failed to activate the connection"));
        return;
      }
      toast.success(t("חיבור Meta WhatsApp הופעל", "Meta WhatsApp connection activated"));
      setAccessToken(""); setAppSecret(""); setWebhookVerifyToken("");
      router.refresh();
    } catch { toast.error(t("הבקשה נכשלה. בדוק את החיבור ונסה שוב", "The request failed. Check your connection and try again")); } finally {
      setIsSubmitting(false);
    }
  }

  async function handleSwitchToMock() {
    setIsSwitching(true);
    try {
      const res = await fetch("/api/settings/whatsapp/mock", { method: "POST" });
      if (!res.ok) {
        toast.error(t("שגיאה במעבר לספק המדומה", "Failed to switch to the mock provider"));
        return;
      }
      toast.success(t("עברת לספק המדומה (Mock)", "Switched to the mock provider"));
      router.refresh();
    } catch { toast.error(t("הבקשה נכשלה. בדוק את החיבור ונסה שוב", "The request failed. Check your connection and try again")); } finally {
      setIsSwitching(false);
    }
  }

  async function numberAction(id: string, action: "default" | "disconnect" | "reconnect") {
    setIsSubmitting(true);
    try {
      const response = await fetch(`/api/settings/whatsapp/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t("עדכון המספר נכשל", "Failed to update the number"));
      toast.success(t("המספר עודכן; שיחות וקמפיינים קיימים שומרים על המספר המקורי", "Number updated; existing conversations and campaigns keep their original number")); router.refresh();
    } catch (error) { toast.error(error instanceof Error ? error.message : t("עדכון המספר נכשל", "Failed to update the number")); }
    finally { setIsSubmitting(false); }
  }
  return (
    <div className="max-w-xl space-y-6">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">{t("ספק פעיל כרגע:", "Current provider:")}</span>
        <Badge variant={isMetaActive ? "default" : "secondary"}>
          {isMetaActive ? "Meta WhatsApp Cloud API" : t("ספק מדומה (Mock)", "Mock provider")}
        </Badge>
        {isMetaActive && (
          <Button variant="ghost" size="sm" onClick={handleSwitchToMock} disabled={isSwitching}>
            {isSwitching ? t("עובר...", "Switching...") : t("נתק את כל המספרים ועבור לדמו", "Disconnect all numbers and switch to demo")}
          </Button>
        )}
      </div>

      {isMetaActive && <div className="space-y-2"><Button variant="outline" disabled={checking} onClick={async () => {
        setChecking(true);
        try {
          const res = await fetch("/api/settings/whatsapp/check", { method: "POST" });
          const data = await res.json();
          setReport(res.ok ? `${t("הגישה למספר ולתבניות תקינה.", "Access to the number and templates is OK.")} ${data.hasSubscribedApp ? t("יש אפליקציה רשומה לקבלת אירועים; יש לוודא ב־Meta שזו האפליקציה שלך ולבדוק הודעה נכנסת.", "An app is subscribed to receive events; confirm in Meta that it's your app and test an inbound message.") : t("חסרה הרשמת אפליקציה: יש להגדיר subscribed_apps ב־Meta כדי לקבל הודעות.", "App subscription is missing: set up subscribed_apps in Meta to receive messages.")}` : data.error);
        } catch { setReport(t("בדיקת החיבור נכשלה", "Connection check failed")); }
        finally { setChecking(false); }
      }}>{checking ? t("בודק...", "Checking...") : t("בדוק חיבור Meta", "Test Meta connection")}</Button>{report && <p role="status" className="text-sm">{report}</p>}</div>}
      {isMetaActive && <p className="text-sm">{t("הגדרה שמורה — אינה הוכחת חיבור פעיל. בדיקה אחרונה:", "Saved settings — not proof of an active connection. Last check:")} {summary.lastCheckedAt ? new Date(summary.lastCheckedAt).toLocaleString(locale) : t("טרם נבדק", "not checked yet")}. {summary.lastConnectionError}{summary.sendingBlocked && t(" השליחה חסומה. יש לתקן הרשאות ולשמור את החיבור מחדש.", " Sending is blocked. Fix the permissions and save the connection again.")}</p>}
      <section aria-label={t("מספרי WhatsApp בעסק", "Business WhatsApp numbers")} className="space-y-3">
        <h2 className="font-semibold">{t("מספרי WhatsApp בעסק", "Business WhatsApp numbers")}</h2>
        <p className="text-xs text-muted-foreground">{t("אפשר לחבר כמה מספרים מאותו חשבון WhatsApp Business. ברירת המחדל חלה רק על שיחות וקמפיינים חדשים. העברת מספר לצוות חדש מחזירה ללא שיוך שיחות של נציגים שאינם בצוות החדש.", "You can connect several numbers from the same WhatsApp Business account. The default applies only to new conversations and campaigns. Moving a number to a new team unassigns conversations of agents who aren't in that team.")}</p>
        {numbers.map((number) => <article key={number.id} className="space-y-2 rounded border p-3">
          <p className="font-medium">{number.label || number.displayPhoneNumber || `WhatsApp ${number.phoneNumberId}`} {number.isDefault && <Badge>{t("ברירת מחדל", "Default")}</Badge>}</p>
          <p><Ltr>{number.displayPhoneNumber || number.phoneNumberId}</Ltr> · {teams.find((team) => team.id === number.teamId)?.name || t("כל הצוותים", "All teams")}</p>
          <p className="text-sm">{!number.isActive ? t("מנותק — ההיסטוריה נשמרה", "Disconnected — history kept") : number.sendingBlocked ? t("השליחה חסומה; יש לתקן הרשאות ולחבר מחדש", "Sending blocked; fix permissions and reconnect") : t("מוגדר לשליחה", "Ready to send")}</p>
          <p className="text-xs">{t("בדיקת גישה:", "Access check:")} {number.lastCheckedAt ? new Date(number.lastCheckedAt).toLocaleString(locale) : t("טרם נבדק", "not checked yet")} · {t("Webhook חתום אחרון:", "Last signed webhook:")} {number.lastWebhookAt ? new Date(number.lastWebhookAt).toLocaleString(locale) : t("טרם התקבל", "none received yet")}</p>
          {number.lastConnectionError && <p role="alert">{t(number.lastConnectionError, META_REASON_EN[number.lastConnectionError] ?? number.lastConnectionError)}</p>}
          <div className="flex flex-wrap gap-2">
            {number.isActive && <Button variant="outline" disabled={checking} onClick={async () => { setChecking(true); try { const res = await fetch("/api/settings/whatsapp/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credentialId: number.id }) }); const data = await res.json(); if (res.ok) toast.success(t("הגישה למספר אומתה; תקינות קבלת הודעות דורשת Webhook חתום", "Number access verified; receiving messages requires a signed webhook")); else toast.error(data.error); router.refresh(); } catch { toast.error(t("בדיקת החיבור נכשלה", "Connection check failed")); } finally { setChecking(false); } }}>{t("בדוק מספר", "Test number")}</Button>}
            {number.isActive ? <><Button variant="outline" disabled={isSubmitting || number.isDefault || number.sendingBlocked} onClick={() => numberAction(number.id, "default")}>{t("קבע כברירת מחדל", "Set as default")}</Button><Button variant="outline" disabled={isSubmitting} onClick={() => numberAction(number.id, "disconnect")}>{t("נתק מספר", "Disconnect number")}</Button></> : <Button disabled={isSubmitting} onClick={() => numberAction(number.id, "reconnect")}>{t("אמת וחבר מחדש", "Verify and reconnect")}</Button>}
            <Button variant="ghost" onClick={() => { setPhoneNumberId(number.phoneNumberId || ""); setLabel(number.label || ""); setTeamId(number.teamId || ""); }}>{t("ערוך פרטי חיבור", "Edit connection details")}</Button>
          </div>
        </article>)}
        {!numbers.length && <p className="text-sm text-muted-foreground">{t("לא חובר עדיין מספר WhatsApp.", "No WhatsApp number connected yet.")}</p>}
      </section>
      <Separator />

      <div className="space-y-2">
        <Label>Webhook Callback URL</Label>
        <p className="text-xs text-muted-foreground">
          {t("הדבק כתובת זו ב-Meta App Dashboard תחת WhatsApp → Configuration → Webhook, יחד עם ה-Verify Token שתגדיר למטה. יש להירשם לשדה messages ולחבר את האפליקציה לחשבון WhatsApp דרך subscribed_apps. השתמש ב־Token קבוע עם הרשאות whatsapp_business_management ו־whatsapp_business_messaging.", "Paste this URL in the Meta App Dashboard under WhatsApp → Configuration → Webhook, together with the Verify Token you set below. Subscribe to the messages field and connect the app to the WhatsApp account via subscribed_apps. Use a permanent token with the whatsapp_business_management and whatsapp_business_messaging permissions.")}
        </p>
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <Ltr>{webhookUrl}</Ltr>
        </div>
      </div>

      <Separator />

      <div className="space-y-4">
        <h2 className="text-sm font-medium">{t("חיבור Meta WhatsApp Cloud API", "Meta WhatsApp Cloud API connection")}</h2>

        {isMetaActive && (
          <p className="text-xs text-muted-foreground">
            {t("מוגדר כרגע:", "Currently configured:")} Phone Number ID <Ltr className="inline">{summary.phoneNumberId}</Ltr>, Access Token{" "}
            <Ltr className="inline">{summary.accessTokenMasked}</Ltr>
            {summary.hasAppSecret ? t(", App Secret מוגדר", ", App Secret set") : ""}. {t("מלא שוב את השדות למטה כדי לעדכן.", "Fill in the fields below again to update.")}
          </p>
        )}

        <div className="space-y-1.5"><Label htmlFor="number-label">{t("שם המספר", "Number name")}</Label><Input id="number-label" value={label} maxLength={100} onChange={(event) => setLabel(event.target.value)} placeholder={t("לדוגמה: מכירות או שירות לקוחות", "e.g. Sales or Customer service")} /></div>
        <label className="block space-y-1">{t("צוות המספר", "Number team")}<select aria-label={t("צוות המספר", "Number team")} className="w-full rounded border p-2" value={teamId} onChange={(event) => setTeamId(event.target.value)}><option value="">{t("כל הצוותים", "All teams")}</option>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
        <label className="flex gap-2"><input type="checkbox" checked={makeDefault} onChange={(event) => setMakeDefault(event.target.checked)} />{t("השתמש כברירת מחדל לשיחות וקמפיינים חדשים", "Use as default for new conversations and campaigns")}</label>
        <div className="space-y-1.5">
          <Label>Phone Number ID</Label>
          <Input dir="ltr" className="text-left" value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>WhatsApp Business Account ID {t("(חובה)", "(required)")}</Label>
          <Input dir="ltr" className="text-left" value={businessAccountId} onChange={(e) => setBusinessAccountId(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>Access Token</Label>
          <Input dir="ltr" className="text-left" type="password" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>Webhook Verify Token</Label>
          <Input
            dir="ltr"
            className="text-left"
            value={webhookVerifyToken}
            onChange={(e) => setWebhookVerifyToken(e.target.value)}
            placeholder={t("מחרוזת שתבחר בעצמך, זהה למה שתכניס ב-Meta", "A string of your choice, identical to the one you enter in Meta")}
          />
        </div>
        <div className="space-y-1.5">
          <Label>App Secret {t("(חובה, לאימות חתימת webhook)", "(required, for webhook signature verification)")}</Label>
          <Input dir="ltr" className="text-left" type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} />
        </div>

        <Button onClick={handleActivateMeta} disabled={isSubmitting || !accessToken || !phoneNumberId || !businessAccountId || !webhookVerifyToken || !appSecret}>
          {isSubmitting ? t("מפעיל...", "Activating...") : t("שמור והפעל", "Save and activate")}
        </Button>
      </div>
    </div>
  );
}
