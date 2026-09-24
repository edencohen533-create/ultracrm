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

interface NumberSummary { id: string; label: string | null; displayPhoneNumber: string | null; phoneNumberId: string | null; teamId: string | null; isActive: boolean; isDefault: boolean; sendingBlocked: boolean; lastCheckedAt: string | null; lastWebhookAt: string | null; lastConnectionError: string | null }
export function WhatsAppProviderForm({ initialSummary, webhookUrl, numbers = [], teams = [] }: { initialSummary: Summary; webhookUrl: string; numbers?: NumberSummary[]; teams?: { id: string; name: string }[] }) {
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
        toast.error(typeof data?.error === "string" ? data.error : "שגיאה בהפעלת החיבור");
        return;
      }
      toast.success("חיבור Meta WhatsApp הופעל");
      setAccessToken(""); setAppSecret(""); setWebhookVerifyToken("");
      router.refresh();
    } catch { toast.error("הבקשה נכשלה. בדוק את החיבור ונסה שוב"); } finally {
      setIsSubmitting(false);
    }
  }

  async function handleSwitchToMock() {
    setIsSwitching(true);
    try {
      const res = await fetch("/api/settings/whatsapp/mock", { method: "POST" });
      if (!res.ok) {
        toast.error("שגיאה במעבר לספק המדומה");
        return;
      }
      toast.success("עברת לספק המדומה (Mock)");
      router.refresh();
    } catch { toast.error("הבקשה נכשלה. בדוק את החיבור ונסה שוב"); } finally {
      setIsSwitching(false);
    }
  }

  async function numberAction(id: string, action: "default" | "disconnect" | "reconnect") {
    setIsSubmitting(true);
    try {
      const response = await fetch(`/api/settings/whatsapp/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "עדכון המספר נכשל");
      toast.success("המספר עודכן; שיחות וקמפיינים קיימים שומרים על המספר המקורי"); router.refresh();
    } catch (error) { toast.error(error instanceof Error ? error.message : "עדכון המספר נכשל"); }
    finally { setIsSubmitting(false); }
  }
  return (
    <div className="max-w-xl space-y-6">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">ספק פעיל כרגע:</span>
        <Badge variant={isMetaActive ? "default" : "secondary"}>
          {isMetaActive ? "Meta WhatsApp Cloud API" : "ספק מדומה (Mock)"}
        </Badge>
        {isMetaActive && (
          <Button variant="ghost" size="sm" onClick={handleSwitchToMock} disabled={isSwitching}>
            {isSwitching ? "עובר..." : "נתק את כל המספרים ועבור לדמו"}
          </Button>
        )}
      </div>

      {isMetaActive && <div className="space-y-2"><Button variant="outline" disabled={checking} onClick={async () => {
        setChecking(true);
        try {
          const res = await fetch("/api/settings/whatsapp/check", { method: "POST" });
          const data = await res.json();
          setReport(res.ok ? `הגישה למספר ולתבניות תקינה. ${data.hasSubscribedApp ? "יש אפליקציה רשומה לקבלת אירועים; יש לוודא ב־Meta שזו האפליקציה שלך ולבדוק הודעה נכנסת." : "חסרה הרשמת אפליקציה: יש להגדיר subscribed_apps ב־Meta כדי לקבל הודעות."}` : data.error);
        } catch { setReport("בדיקת החיבור נכשלה"); }
        finally { setChecking(false); }
      }}>{checking ? "בודק..." : "בדוק חיבור Meta"}</Button>{report && <p role="status" className="text-sm">{report}</p>}</div>}
      {isMetaActive && <p className="text-sm">הגדרה שמורה — אינה הוכחת חיבור פעיל. בדיקה אחרונה: {summary.lastCheckedAt ? new Date(summary.lastCheckedAt).toLocaleString("he-IL") : "טרם נבדק"}. {summary.lastConnectionError}{summary.sendingBlocked && " השליחה חסומה. יש לתקן הרשאות ולשמור את החיבור מחדש."}</p>}
      <section aria-label="מספרי WhatsApp בעסק" className="space-y-3">
        <h2 className="font-semibold">מספרי WhatsApp בעסק</h2>
        <p className="text-xs text-muted-foreground">אפשר לחבר כמה מספרים מאותו חשבון WhatsApp Business. ברירת המחדל חלה רק על שיחות וקמפיינים חדשים. העברת מספר לצוות חדש מחזירה ללא שיוך שיחות של נציגים שאינם בצוות החדש.</p>
        {numbers.map((number) => <article key={number.id} className="space-y-2 rounded border p-3">
          <p className="font-medium">{number.label || number.displayPhoneNumber || `WhatsApp ${number.phoneNumberId}`} {number.isDefault && <Badge>ברירת מחדל</Badge>}</p>
          <p><Ltr>{number.displayPhoneNumber || number.phoneNumberId}</Ltr> · {teams.find((team) => team.id === number.teamId)?.name || "כל הצוותים"}</p>
          <p className="text-sm">{!number.isActive ? "מנותק — ההיסטוריה נשמרה" : number.sendingBlocked ? "השליחה חסומה; יש לתקן הרשאות ולחבר מחדש" : "מוגדר לשליחה"}</p>
          <p className="text-xs">בדיקת גישה: {number.lastCheckedAt ? new Date(number.lastCheckedAt).toLocaleString("he-IL") : "טרם נבדק"} · Webhook חתום אחרון: {number.lastWebhookAt ? new Date(number.lastWebhookAt).toLocaleString("he-IL") : "טרם התקבל"}</p>
          {number.lastConnectionError && <p role="alert">{number.lastConnectionError}</p>}
          <div className="flex flex-wrap gap-2">
            {number.isActive && <Button variant="outline" disabled={checking} onClick={async () => { setChecking(true); try { const res = await fetch("/api/settings/whatsapp/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credentialId: number.id }) }); const data = await res.json(); if (res.ok) toast.success("הגישה למספר אומתה; תקינות קבלת הודעות דורשת Webhook חתום"); else toast.error(data.error); router.refresh(); } catch { toast.error("בדיקת החיבור נכשלה"); } finally { setChecking(false); } }}>בדוק מספר</Button>}
            {number.isActive ? <><Button variant="outline" disabled={isSubmitting || number.isDefault || number.sendingBlocked} onClick={() => numberAction(number.id, "default")}>קבע כברירת מחדל</Button><Button variant="outline" disabled={isSubmitting} onClick={() => numberAction(number.id, "disconnect")}>נתק מספר</Button></> : <Button disabled={isSubmitting} onClick={() => numberAction(number.id, "reconnect")}>אמת וחבר מחדש</Button>}
            <Button variant="ghost" onClick={() => { setPhoneNumberId(number.phoneNumberId || ""); setLabel(number.label || ""); setTeamId(number.teamId || ""); }}>ערוך פרטי חיבור</Button>
          </div>
        </article>)}
        {!numbers.length && <p className="text-sm text-muted-foreground">לא חובר עדיין מספר WhatsApp.</p>}
      </section>
      <Separator />

      <div className="space-y-2">
        <Label>Webhook Callback URL</Label>
        <p className="text-xs text-muted-foreground">
          הדבק כתובת זו ב-Meta App Dashboard תחת WhatsApp → Configuration → Webhook, יחד עם ה-Verify Token שתגדיר למטה. יש להירשם לשדה messages ולחבר את האפליקציה לחשבון WhatsApp דרך subscribed_apps. השתמש ב־Token קבוע עם הרשאות whatsapp_business_management ו־whatsapp_business_messaging.
        </p>
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <Ltr>{webhookUrl}</Ltr>
        </div>
      </div>

      <Separator />

      <div className="space-y-4">
        <h2 className="text-sm font-medium">חיבור Meta WhatsApp Cloud API</h2>

        {isMetaActive && (
          <p className="text-xs text-muted-foreground">
            מוגדר כרגע: Phone Number ID <Ltr className="inline">{summary.phoneNumberId}</Ltr>, Access Token{" "}
            <Ltr className="inline">{summary.accessTokenMasked}</Ltr>
            {summary.hasAppSecret ? ", App Secret מוגדר" : ""}. מלא שוב את השדות למטה כדי לעדכן.
          </p>
        )}

        <div className="space-y-1.5"><Label htmlFor="number-label">שם המספר</Label><Input id="number-label" value={label} maxLength={100} onChange={(event) => setLabel(event.target.value)} placeholder="לדוגמה: מכירות או שירות לקוחות" /></div>
        <label className="block space-y-1">צוות המספר<select aria-label="צוות המספר" className="w-full rounded border p-2" value={teamId} onChange={(event) => setTeamId(event.target.value)}><option value="">כל הצוותים</option>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
        <label className="flex gap-2"><input type="checkbox" checked={makeDefault} onChange={(event) => setMakeDefault(event.target.checked)} />השתמש כברירת מחדל לשיחות וקמפיינים חדשים</label>
        <div className="space-y-1.5">
          <Label>Phone Number ID</Label>
          <Input dir="ltr" className="text-left" value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>WhatsApp Business Account ID (חובה)</Label>
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
            placeholder="מחרוזת שתבחר בעצמך, זהה למה שתכניס ב-Meta"
          />
        </div>
        <div className="space-y-1.5">
          <Label>App Secret (חובה, לאימות חתימת webhook)</Label>
          <Input dir="ltr" className="text-left" type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} />
        </div>

        <Button onClick={handleActivateMeta} disabled={isSubmitting || !accessToken || !phoneNumberId || !businessAccountId || !webhookVerifyToken || !appSecret}>
          {isSubmitting ? "מפעיל..." : "שמור והפעל"}
        </Button>
      </div>
    </div>
  );
}
