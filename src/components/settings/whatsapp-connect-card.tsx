"use client";

/**
 * "חבר WhatsApp" – Meta Embedded Signup (Facebook Login for Business, response_type=code).
 *
 * Trust boundary: the browser only ever sees the App ID, the Embedded Signup config id and
 * a short-lived one-time `state`. The exchangeable code is posted to our server immediately
 * (30 s TTL) and the access token never reaches the browser.
 *
 * `window.message` events are accepted only from *.facebook.com origins and only with the
 * documented `WA_EMBEDDED_SIGNUP` structure. The popup closing is never treated as success.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Ltr } from "@/components/shared/ltr";
import { useT } from "@/components/i18n/LangProvider";

type Translate = (he: string, en: string) => string;

type WaStatus = "disconnected" | "in_progress" | "needs_action" | "connected_not_ready" | "connected" | "revoked" | "error";

export interface ConnectionView {
  id: string; label: string | null; method: string; status: WaStatus; sendReady: boolean; receiveReady: boolean; blockers: string[]; hints?: string[]; metaBusinessId?: string | null;
  wabaId: string | null; wabaName: string | null; phoneNumberId: string | null; displayPhoneNumber: string | null; verifiedName: string | null; nameStatus: string | null;
  qualityRating: string | null; messagingLimitTier?: string | null; codeVerificationStatus: string | null; platformType: string | null; grantedScopes: unknown; isDefault: boolean; isActive: boolean;
  team: { id: string; name: string } | null; subscribedAt: string | null; registeredAt: string | null; tokenCheckedAt: string | null; lastCheckedAt: string | null;
  lastWebhookAt: string | null; lastOutboundTestAt: string | null; lastError: string | null; sendingBlocked: boolean; createdAt: string;
  testRecipients?: string[]; unitPrice?: number | null; unitPriceCurrency?: string | null;
}
export interface Overview {
  embeddedSignup: { ready: boolean; missing: string[]; appId: string | null; configId: string | null; version: string };
  pendingSession: { id: string; userId: string; createdAt: string } | null;
  connections: ConnectionView[];
}

const STATUS: Record<WaStatus, { label: string; en: string; tone: "default" | "secondary" | "destructive" | "outline"; className?: string }> = {
  disconnected: { label: "לא מחובר", en: "Not connected", tone: "outline" },
  in_progress: { label: "חיבור בתהליך", en: "Connection in progress", tone: "secondary" },
  needs_action: { label: "נדרשת פעולה ב-Meta", en: "Action required in Meta", tone: "destructive", className: "bg-amber-500 text-black" },
  connected_not_ready: { label: "מחובר – לא מוכן", en: "Connected – not ready", tone: "secondary", className: "bg-amber-100 text-amber-900" },
  connected: { label: "מחובר ופעיל", en: "Connected and active", tone: "default", className: "bg-emerald-600 text-white" },
  revoked: { label: "ההרשאה בוטלה – נדרש חיבור מחדש", en: "Permission revoked – reconnect required", tone: "destructive" },
  error: { label: "תקלה", en: "Error", tone: "destructive" },
};

type Flow = { kind: "idle" } | { kind: "loading_sdk" } | { kind: "popup" } | { kind: "exchanging" } | { kind: "error"; message: string } | { kind: "cancelled"; step?: string };

declare global {
  interface Window {
    FB?: { init: (o: Record<string, unknown>) => void; login: (cb: (r: FbLoginResponse) => void, o: Record<string, unknown>) => void };
    fbAsyncInit?: () => void;
  }
}
interface FbLoginResponse { status?: string; authResponse?: { code?: string; userID?: string } | null }
interface SignupStart { state: string; expiresAt: string; appId: string; configId: string; version: string; reused: boolean }
interface EsMessage { type: "WA_EMBEDDED_SIGNUP"; event: "FINISH" | "FINISH_ONLY_WABA" | "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" | "CANCEL" | "ERROR"; data: { phone_number_id?: string; waba_id?: string; business_id?: string; current_step?: string; error_message?: string; error_id?: string } }

function isEsMessage(v: unknown): v is EsMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  if (m.type !== "WA_EMBEDDED_SIGNUP" || typeof m.event !== "string") return false;
  const d = m.data;
  if (!d || typeof d !== "object") return false;
  for (const k of ["phone_number_id", "waba_id", "business_id"]) {
    const x = (d as Record<string, unknown>)[k];
    if (x !== undefined && (typeof x !== "string" || !/^\d{1,40}$/.test(x))) return false;
  }
  return true;
}
function trustedOrigin(origin: string) {
  try { const h = new URL(origin).hostname; return origin.startsWith("https://") && (h === "facebook.com" || h.endsWith(".facebook.com")); } catch { return false; }
}

let sdkPromise: Promise<void> | null = null;
function loadFbSdk(appId: string, version: string, t: Translate) {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.FB) return Promise.resolve();
  if (!sdkPromise) sdkPromise = new Promise<void>((resolve, reject) => {
    window.fbAsyncInit = () => { window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version }); resolve(); };
    const s = document.createElement("script");
    s.src = "https://connect.facebook.net/en_US/sdk.js"; s.async = true; s.defer = true; s.crossOrigin = "anonymous";
    s.onerror = () => { sdkPromise = null; reject(new Error(t("טעינת Facebook SDK נכשלה (חוסם פרסומות / רשת?)", "Failed to load the Facebook SDK (ad blocker / network?)"))); };
    document.body.appendChild(s);
    setTimeout(() => { if (!window.FB) { sdkPromise = null; reject(new Error(t("Facebook SDK לא נטען בזמן", "The Facebook SDK did not load in time"))); } }, 20_000);
  });
  return sdkPromise;
}

async function api<T>(t: Translate, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json?.error?.message ?? json?.error ?? json?.message ?? t(`שגיאה ${res.status}`, `Error ${res.status}`)), { code: json?.error?.code ?? json?.code, details: json?.error?.details ?? json?.details });
  return (json?.data ?? json) as T;
}

/** Server signup errors are Hebrew; English by error code. */
const ES_ERR_EN: Record<string, string> = {
  signup_not_configured: "Embedded Signup is not configured on the server", signup_in_progress: "Another user in this business already has a connection flow open – wait for it to finish",
  signup_state_mismatch: "This connection flow does not belong to the current user/business", signup_expired: "The connection flow expired – start again",
  code_reused: "The authorization code was already used", signup_already_claimed: "The connection is already being processed (double click?) – wait for it to finish",
  token_exchange_failed: "Exchanging the authorization code with Meta failed (the code is valid for 30 seconds only) – try again", token_invalid: "The token received is not valid",
  token_app_mismatch: "The token belongs to another app", scopes_missing: "These permissions were not granted", waba_not_granted: "The permission granted does not include the selected WhatsApp account",
  phone_not_in_waba: "The selected number does not belong to the approved WhatsApp account", phone_bound_elsewhere: "This number is already connected to another business in the system. Disconnect it there first",
  waba_conflict: "Another WhatsApp account is already connected to this business. Disconnect it before connecting a new one", not_found: "Connection not found",
  test_recipient_not_allowed: "Test sends are allowed only to test numbers explicitly set on the connection",
};
/** Readiness blockers arrive from the server in Hebrew (embedded-signup-service connectionReadiness). */
const blockerEn = (b: string) => ({
  "החיבור מנותק": "The connection is disconnected", "ההרשאה בוטלה בצד Meta – נדרש חיבור מחדש": "Permission was revoked at Meta – reconnect required", "תקלה בחיבור": "Connection error",
  "ההרשאה טרם אומתה מול Meta": "Permission not yet verified with Meta", "האפליקציה אינה רשומה לאירועי ה-WABA (subscribed_apps)": "The app is not subscribed to the WABA's events (subscribed_apps)",
  "המספר אינו רשום ל-Cloud API (register)": "The number is not registered for the Cloud API (register)",
  "Meta: בקשת מחיקת נתונים": "Meta: data deletion request", "Meta: האפליקציה הוסרה על ידי המשתמש": "Meta: the app was removed by the user", "Meta דחתה שליחה לאחרונה (token/הרשאות) – יש לבדוק חיבור": "Meta recently rejected a send (token/permissions) – test the connection",
} as Record<string, string>)[b] ?? b.replace(/^חסרה הרשאה /, "Missing permission ").replace(/^אימות המספר אצל Meta: /, "Number verification at Meta: ");
const esError = (t: Translate, e: unknown) => { const err = e as Error & { code?: string }; return t(err.message, (err.code && ES_ERR_EN[err.code]) || err.message); };

const fmtDate = (v: string | null, locale: string) => (v ? new Date(v).toLocaleString(locale) : "—");

export function WhatsAppConnectCard({ initial, webhookUrl, canManage }: { initial: Overview; webhookUrl: string; canManage: boolean }) {
  const t = useT();
  const fmt = (v: string | null) => fmtDate(v, t.lang === "en" ? "en-GB" : "he-IL");
  const router = useRouter();
  const [overview, setOverview] = useState<Overview>(initial);
  const [flow, setFlow] = useState<Flow>({ kind: "idle" });
  const [busy, setBusy] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [testTo, setTestTo] = useState("");
  const [allow, setAllow] = useState<Record<string, string>>({});
  const [price, setPrice] = useState<Record<string, string>>({});
  const [confirmDisconnect, setConfirmDisconnect] = useState<ConnectionView | null>(null);
  const inFlight = useRef(false);           // double-click guard
  const stateRef = useRef<string | null>(null);
  const assetsRef = useRef<EsMessage["data"] | null>(null);

  const refresh = useCallback(async () => {
    try { setOverview(await api<Overview>(t, "/api/whatsapp/connection")); router.refresh(); } catch (e) { toast.error((e as Error).message); }
  }, [router, t]);

  // Preload the SDK so the click reaches FB.login quickly – a long await after the click lets browsers block the popup.
  const sdk = overview.embeddedSignup;
  useEffect(() => {
    if (canManage && sdk.ready && sdk.appId) loadFbSdk(sdk.appId, sdk.version, t).catch(() => undefined);
  }, [canManage, sdk.ready, sdk.appId, sdk.version, t]);

  // Assets (waba/phone ids) arrive via postMessage; the code arrives via the FB.login callback. Both are needed.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!trustedOrigin(event.origin)) return;
      let data: unknown = event.data;
      if (typeof data === "string") { try { data = JSON.parse(data); } catch { return; } }
      if (!isEsMessage(data)) return;
      if (data.event === "FINISH" || data.event === "FINISH_ONLY_WABA" || data.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING") assetsRef.current = data.data;
      else if (data.event === "CANCEL") { setFlow({ kind: "cancelled", step: data.data.current_step }); void cancel(`cancelled at ${data.data.current_step ?? "?"}`, data.data.current_step); }
      else if (data.event === "ERROR") { setFlow({ kind: "error", message: data.data.error_message ?? t("שגיאה בתהליך ההרשמה של Meta", "Error in the Meta signup flow") }); void cancel(data.data.error_message ?? "error"); }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [t]);

  async function cancel(reason: string, step?: string) {
    const state = stateRef.current; stateRef.current = null; inFlight.current = false;
    if (state) await api(t, "/api/whatsapp/signup/cancel", { state, reason, step }).catch(() => undefined);
  }

  async function connect() {
    if (inFlight.current) return; // parallel flow prevention
    inFlight.current = true; assetsRef.current = null;
    try {
      setFlow({ kind: "loading_sdk" });
      const start = await api<SignupStart>(t, "/api/whatsapp/signup/start", {});
      stateRef.current = start.state;
      await loadFbSdk(start.appId, start.version, t);
      setFlow({ kind: "popup" });
      const opened = await new Promise<FbLoginResponse>((resolve) => {
        window.FB!.login((r) => resolve(r), {
          config_id: start.configId, response_type: "code", override_default_response_type: true,
          extras: { setup: {} }, // Embedded Signup v4 – the version comes from the Login for Business configuration
        });
      });
      const code = opened.authResponse?.code;
      if (!code) {
        // Closed without completing (cancel, or popup blocked → FB reports "unknown").
        const blocked = opened.status === "unknown" && !assetsRef.current;
        setFlow(blocked ? { kind: "error", message: t("החלון של Meta לא נפתח או נסגר. בטל חסימת חלונות קופצים לאתר ונסה שוב.", "The Meta window didn't open or was closed. Allow pop-ups for this site and try again.") } : { kind: "cancelled" });
        await cancel(blocked ? "popup_blocked_or_closed" : "no_code");
        return;
      }
      // Wait briefly for the FINISH message (it can arrive just after the callback).
      for (let i = 0; i < 20 && !assetsRef.current; i++) await new Promise((r) => setTimeout(r, 100));
      const assets = assetsRef.current as EsMessage["data"] | null;
      if (!assets?.waba_id || !assets.phone_number_id) {
        setFlow({ kind: "error", message: t("Meta לא החזירה מזהי חשבון/מספר. אם רק נוצר חשבון WABA ללא מספר – הוסף מספר ב-Meta ונסה שוב.", "Meta didn't return account/number IDs. If only a WABA was created without a number, add a number in Meta and try again.") });
        await cancel("missing_assets");
        return;
      }
      setFlow({ kind: "exchanging" });
      const result = await api<{ credentialId: string; status: WaStatus; step: string; error?: string }>(t, "/api/whatsapp/signup/complete", {
        state: start.state, code, fbUserId: opened.authResponse?.userID || undefined, wabaId: assets.waba_id, phoneNumberId: assets.phone_number_id, metaBusinessId: assets.business_id,
      });
      stateRef.current = null;
      setFlow({ kind: "idle" });
      if (result.status === "connected") toast.success(t("החשבון חובר. בצע בדיקת שליחה וקבלה כדי לאשר מוכנות.", "Account connected. Run a send and receive test to confirm readiness."));
      else toast.warning(result.error ?? t(`החיבור נשמר במצב: ${STATUS[result.status].label}`, `Connection saved with status: ${STATUS[result.status].en}`));
      await refresh();
    } catch (e) {
      const err = e as Error & { code?: string; details?: { missing?: string[] } };
      setFlow({ kind: "error", message: err.code === "scopes_missing" ? t(`${err.message}. חבר מחדש ואשר את כל ההרשאות המבוקשות.`, `${ES_ERR_EN.scopes_missing}: ${err.details?.missing?.join(", ") ?? ""}. Reconnect and approve all requested permissions.`) : esError(t, err) });
      await cancel(err.message);
    } finally { inFlight.current = false; }
  }

  async function act(c: ConnectionView, action: "check" | "retry_setup" | "disconnect" | "test_send" | "settings", extra: Record<string, unknown> = {}) {
    if (busy) return;
    setBusy(`${c.id}:${action}`);
    try {
      const r = await api<{ status?: WaStatus; blockers?: string[]; error?: string | null; warning?: string | null; providerMessageId?: string | null }>(t, `/api/whatsapp/connection/${c.id}`, { action, ...extra });
      if (action === "check") { if (r.status === "connected") toast.success(t("החיבור תקין ומוכן", "Connection OK and ready")); else { const s = STATUS[r.status ?? "error"]; toast.warning(r.error ?? r.blockers?.map((b) => t(b, blockerEn(b))).join(" · ") ?? t(s.label, s.en)); } }
      if (action === "retry_setup") { if (r.status === "connected") toast.success(t("ההגדרה הושלמה", "Setup completed")); else toast.warning(r.error ?? t("עדיין נדרשת פעולה", "Action still required")); }
      if (action === "disconnect") toast.success(r.warning ?? t("החיבור נותק. ההיסטוריה נשמרה.", "Disconnected. History was kept."));
      if (action === "test_send") toast.success(t(`הודעת בדיקה נשלחה${r.providerMessageId ? ` (${r.providerMessageId})` : ""}`, `Test message sent${r.providerMessageId ? ` (${r.providerMessageId})` : ""}`));
      if ((action as string) === "settings") toast.success(t("הגדרות הבדיקה והעלות נשמרו", "Test and cost settings saved"));
      await refresh();
    } catch (e) { toast.error(esError(t, e)); }
    finally { setBusy(null); }
  }

  const es = overview.embeddedSignup;
  const active = overview.connections.filter((c) => c.isActive);
  const history = overview.connections.filter((c) => !c.isActive);
  const flowBusy = flow.kind === "loading_sdk" || flow.kind === "popup" || flow.kind === "exchanging";

  return (
    <section className="rounded-xl border bg-card p-5 shadow-sm" data-testid="wa-connect-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">WhatsApp Business (Meta Cloud API)</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("חיבור חשבון הוואטסאפ העסקי לשליחה וקבלת הודעות בתוך UltraCRM", "Connect your WhatsApp Business account to send and receive messages in UltraCRM")}</p>
        </div>
        <div className="flex items-center gap-2">
          {active.length === 0 && <Badge variant="outline">{t("לא מחובר", "Not connected")}</Badge>}
          {canManage && (
            <Button onClick={connect} disabled={!es.ready || flowBusy} data-testid="wa-connect-btn">
              {flow.kind === "loading_sdk" ? t("טוען…", "Loading…") : flow.kind === "popup" ? t("ממתין ל-Meta…", "Waiting for Meta…") : flow.kind === "exchanging" ? t("מאמת ומגדיר…", "Verifying and setting up…") : active.length ? t("חבר חשבון נוסף", "Connect another account") : t("חבר WhatsApp", "Connect WhatsApp")}
            </Button>
          )}
        </div>
      </div>

      {!es.ready && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="wa-missing-config">
          <div className="font-medium">{t("החיבור באמצעות Meta Embedded Signup אינו זמין עדיין – חסרה הגדרה בשרת:", "Connecting via Meta Embedded Signup isn't available yet – server configuration is missing:")}</div>
          <ul className="mt-1 list-disc pe-5 font-mono text-xs">{es.missing.map((m) => <li key={m}><Ltr>{m}</Ltr></li>)}</ul>
          <div className="mt-2">{t("ראו", "See")} <span className="font-mono">docs/WHATSAPP_EMBEDDED_SIGNUP.md</span> {t("להגדרת האפליקציה ב-Meta. עד אז ניתן להשתמש בחיבור הידני למטה.", "to set up the app in Meta. Until then, you can use the manual connection below.")}</div>
        </div>
      )}
      {!canManage && <p className="mt-3 text-sm text-muted-foreground">{t("רק בעל העסק או מנהל מורשה יכולים לחבר, לבדוק או לנתק חשבון.", "Only the business owner or an authorized manager can connect, test or disconnect an account.")}</p>}

      {flow.kind === "popup" && <p className="mt-3 text-sm">{t("נפתח חלון של Meta. השלם בו את בחירת החשבון והמספר ואשר את ההרשאות. אם לא נפתח חלון – בדוק חסימת חלונות קופצים.", "A Meta window has opened. Select the account and number there and approve the permissions. If no window opened, check your pop-up blocker.")}</p>}
      {flow.kind === "exchanging" && <p className="mt-3 text-sm">{t("מחליף קוד הרשאה מול Meta, מאמת נכסים, נרשם לאירועים ורושם את המספר…", "Exchanging the authorization code with Meta, verifying assets, subscribing to webhooks and registering the number…")}</p>}
      {flow.kind === "cancelled" && <p className="mt-3 text-sm text-muted-foreground" data-testid="wa-flow-cancelled">{t(`התהליך בוטל${flow.step ? ` בשלב ${flow.step}` : ""}. לא בוצע שינוי.`, `The process was cancelled${flow.step ? ` at step ${flow.step}` : ""}. No changes were made.`)}</p>}
      {flow.kind === "error" && <p className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive" data-testid="wa-flow-error">{flow.message}</p>}

      {active.map((c) => {
        const st = STATUS[c.status];
        return (
          <div key={c.id} className="mt-4 rounded-lg border p-4" data-testid={`wa-conn-${c.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={st.tone} className={st.className} data-testid="wa-status">{t(st.label, st.en)}</Badge>
                {c.isDefault && <Badge variant="outline">{t("ברירת מחדל", "Default")}</Badge>}
                <Badge variant="outline">{c.method === "embedded_signup" ? "Embedded Signup" : t("חיבור ידני", "Manual connection")}</Badge>
              </div>
              <div className="text-xs text-muted-foreground">{t("נבדק לאחרונה:", "Last checked:")} {fmt(c.lastCheckedAt)}</div>
            </div>
            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              <div className="flex flex-wrap gap-x-2"><dt className="text-muted-foreground">{t("חשבון:", "Account:")}</dt><dd className="min-w-0">{c.wabaName ?? "—"} <span className="font-mono text-xs text-muted-foreground"><Ltr>{c.wabaId ?? ""}</Ltr></span></dd></div>
              <div className="flex gap-2"><dt className="text-muted-foreground">{t("מספר:", "Number:")}</dt><dd><Ltr>{c.displayPhoneNumber ?? c.phoneNumberId ?? "—"}</Ltr></dd></div>
              <div className="flex gap-2"><dt className="text-muted-foreground">{t("תיק עסק ב-Meta:", "Meta business portfolio:")}</dt><dd className="font-mono text-xs"><Ltr>{c.metaBusinessId ?? "—"}</Ltr></dd></div>
              <div className="flex gap-2"><dt className="text-muted-foreground">{t("שם מאומת:", "Verified name:")}</dt><dd>{c.verifiedName ?? "—"} {c.nameStatus && <span className="text-xs text-muted-foreground">({c.nameStatus})</span>}</dd></div>
              <div className="flex gap-2"><dt className="text-muted-foreground">{t("איכות:", "Quality:")}</dt><dd data-testid="wa-quality">{({ GREEN: t("🟢 גבוהה", "🟢 High"), YELLOW: t("🟡 בינונית", "🟡 Medium"), RED: t("🔴 נמוכה", "🔴 Low") } as Record<string, string>)[c.qualityRating ?? ""] ?? c.qualityRating ?? "—"}</dd></div>
              <div className="flex gap-2"><dt className="text-muted-foreground">{t("מגבלת הודעות:", "Messaging limit:")}</dt><dd data-testid="wa-tier">{({ TIER_250: t("250 לקוחות ביום", "250 customers/day"), TIER_1K: t("1,000 לקוחות ביום", "1,000 customers/day"), TIER_10K: t("10,000 לקוחות ביום", "10,000 customers/day"), TIER_100K: t("100,000 לקוחות ביום", "100,000 customers/day"), TIER_UNLIMITED: t("ללא הגבלה", "Unlimited") } as Record<string, string>)[c.messagingLimitTier ?? ""] ?? c.messagingLimitTier ?? "—"}</dd></div>
              <div className="flex gap-2"><dt className="text-muted-foreground">{t("שליחה:", "Sending:")}</dt><dd>{c.sendReady ? <span className="text-emerald-700">{t("מוכן", "Ready")}</span> : <span className="text-amber-700">{t("לא מוכן", "Not ready")}</span>}{c.lastOutboundTestAt ? t(` · בדיקת שליחה: ${fmt(c.lastOutboundTestAt)}`, ` · Send test: ${fmt(c.lastOutboundTestAt)}`) : t(" · טרם בוצעה בדיקת שליחה", " · No send test yet")}</dd></div>
              <div className="flex gap-2"><dt className="text-muted-foreground">{t("קבלה:", "Receiving:")}</dt><dd>{c.receiveReady ? <span className="text-emerald-700">{t("רשום לאירועים", "Subscribed to webhooks")}</span> : <span className="text-amber-700">{t("לא רשום", "Not subscribed")}</span>}{c.lastWebhookAt ? t(` · אירוע אחרון: ${fmt(c.lastWebhookAt)}`, ` · Last event: ${fmt(c.lastWebhookAt)}`) : t(" · טרם התקבל אירוע מ-Meta", " · No event received from Meta yet")}</dd></div>
            </dl>
            {(c.hints?.length ?? 0) > 0 && (
              <div className="mt-3 text-sm" data-testid="wa-hints"><p className="font-medium">{t("להשלמת ההגדרה:", "To complete the setup:")}</p><ul className="list-disc pe-5 text-muted-foreground">{c.hints!.map((h) => <li key={h} dir="auto">{h}</li>)}</ul></div>
            )}
            {c.blockers.length > 0 && (
              <ul className="mt-3 list-disc pe-5 text-sm text-amber-800" data-testid="wa-blockers">{c.blockers.map((b) => <li key={b}>{t(b, blockerEn(b))}</li>)}</ul>
            )}
            {c.lastError && <p className="mt-2 text-sm text-destructive" data-testid="wa-last-error">{t(c.lastError, blockerEn(c.lastError))}</p>}

            {canManage && (
              <div className="mt-4 flex flex-wrap items-end gap-2">
                <Button variant="outline" size="sm" onClick={() => act(c, "check")} disabled={busy !== null} data-testid="wa-check">{busy === `${c.id}:check` ? t("בודק…", "Checking…") : t("בדוק חיבור", "Test connection")}</Button>
                {(c.status === "needs_action" || c.status === "connected_not_ready" || c.status === "error") && c.method === "embedded_signup" && (
                  <Button variant="outline" size="sm" onClick={() => act(c, "retry_setup", pin ? { pin } : {})} disabled={busy !== null} data-testid="wa-retry">{t("השלם הגדרה", "Complete setup")}</Button>
                )}
                {c.method === "embedded_signup" && c.status === "needs_action" && /דו-שלבי|pin/i.test(c.lastError ?? "") && (
                  <div className="flex items-end gap-2">
                    <div><Label htmlFor={`pin-${c.id}`} className="text-xs">{t("קוד אימות דו-שלבי (6 ספרות)", "Two-step verification PIN (6 digits)")}</Label><Input id={`pin-${c.id}`} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" className="w-32" dir="ltr" /></div>
                  </div>
                )}
                {c.status === "revoked" || c.status === "error" || c.status === "needs_action" ? (
                  <Button variant="outline" size="sm" onClick={connect} disabled={!es.ready || flowBusy} data-testid="wa-reconnect">{t("חבר מחדש", "Reconnect")}</Button>
                ) : null}
                <Button variant="destructive" size="sm" onClick={() => setConfirmDisconnect(c)} disabled={busy !== null} data-testid="wa-disconnect">{t("נתק", "Disconnect")}</Button>
              </div>
            )}
            {canManage && (
              <div className="mt-3 flex flex-wrap items-end gap-2 border-t pt-3" data-testid="wa-settings">
                <div className="min-w-0 max-w-full"><Label htmlFor={`allow-${c.id}`} className="text-xs">{t("מספרי בדיקה מורשים (מופרדים בפסיק) – שליחות בדיקה יוצאות רק אליהם", "Allowed test numbers (comma-separated) – test sends go only to them")}</Label><Input id={`allow-${c.id}`} value={allow[c.id] ?? (c.testRecipients ?? []).join(", ")} onChange={(e) => setAllow({ ...allow, [c.id]: e.target.value })} dir="ltr" className="w-full sm:w-72" placeholder="+972501234567" /></div>
                <div><Label htmlFor={`price-${c.id}`} className="text-xs">{t("מחיר ידני לשיחה שיווקית (לאומדן; ריק = לא ידוע)", "Manual price per marketing conversation (for estimates; blank = unknown)")}</Label><Input id={`price-${c.id}`} value={price[c.id] ?? (c.unitPrice?.toString() ?? "")} onChange={(e) => setPrice({ ...price, [c.id]: e.target.value })} dir="ltr" type="number" step="0.001" min="0" className="w-36" /></div>
                <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => act(c, "settings", { testRecipients: (allow[c.id] ?? (c.testRecipients ?? []).join(", ")).split(/[,\n]/).map((s) => s.trim()).filter(Boolean), unitPrice: (price[c.id] ?? c.unitPrice?.toString() ?? "") === "" ? null : Number(price[c.id] ?? c.unitPrice), unitPriceCurrency: "USD" })} data-testid="wa-save-settings">{t("שמור הגדרות בדיקה ועלות", "Save test and cost settings")}</Button>
              </div>
            )}
            {canManage && c.sendReady && (
              <div className="mt-3 flex flex-wrap items-end gap-2 border-t pt-3">
                <div><Label htmlFor={`test-${c.id}`} className="text-xs">{t("בדיקת שליחה למספר בדיקה בלבד (תבנית hello_world)", "Send test to a test number only (hello_world template)")}</Label><Input id={`test-${c.id}`} value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="+9725…" className="w-48" dir="ltr" /></div>
                <Button variant="secondary" size="sm" onClick={() => act(c, "test_send", { to: testTo })} disabled={busy !== null || !testTo} data-testid="wa-test-send">{t("שלח הודעת בדיקה", "Send test message")}</Button>
                <p className="w-full text-xs text-muted-foreground">{t("שלח רק למספר בדיקה שבבעלותך. בדיקת קבלה: שלח הודעה מאותו מספר בדיקה אל המספר העסקי ובדוק ש\"אירוע אחרון\" מתעדכן.", "Send only to a test number you own. To test receiving: send a message from that test number to the business number and check that \"Last event\" updates.")}</p>
              </div>
            )}
          </div>
        );
      })}

      {history.length > 0 && (
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-muted-foreground">{t(`חיבורים קודמים (${history.length}) – ההיסטוריה נשמרת`, `Previous connections (${history.length}) – history is kept`)}</summary>
          <ul className="mt-2 space-y-1">{history.map((c) => <li key={c.id} className="flex flex-wrap gap-2"><Badge variant="outline">{t(STATUS[c.status].label, STATUS[c.status].en)}</Badge><Ltr>{c.displayPhoneNumber ?? c.phoneNumberId ?? c.id}</Ltr><span className="text-muted-foreground">{c.wabaName ?? c.wabaId}</span>{canManage && c.method === "embedded_signup" && <Button variant="link" size="sm" className="h-auto p-0" onClick={connect} disabled={!es.ready || flowBusy}>{t("חבר מחדש", "Reconnect")}</Button>}</li>)}</ul>
        </details>
      )}

      <Separator className="my-4" />
      <div className="text-xs text-muted-foreground">
        <div>{t("Webhook URL (מוגדר פעם אחת ברמת האפליקציה ב-Meta):", "Webhook URL (configured once at the app level in Meta):")} <Ltr className="max-w-full break-all"><code>{webhookUrl}</code></Ltr></div>
        <div className="mt-1">Graph API {es.version}{es.appId ? <> · App ID <Ltr><code>{es.appId}</code></Ltr></> : null}</div>
      </div>

      <AlertDialog open={confirmDisconnect !== null} onOpenChange={(o) => !o && setConfirmDisconnect(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(`לנתק את ${confirmDisconnect?.displayPhoneNumber ?? "החשבון"}?`, `Disconnect ${confirmDisconnect?.displayPhoneNumber ?? "this account"}?`)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("שליחת הודעות מהמספר תיפסק מיד והאפליקציה תפסיק לקבל אירועים עבורו. השיחות וההיסטוריה יישמרו. חשבון ה-WhatsApp והמספר עצמם לא נמחקים ב-Meta. ניתן לחבר מחדש בכל עת.", "Sending from this number stops immediately and the app stops receiving events for it. Conversations and history are kept. The WhatsApp account and number themselves are not deleted in Meta. You can reconnect at any time.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("ביטול", "Cancel")}</AlertDialogCancel>
            <AlertDialogAction data-testid="wa-disconnect-confirm" onClick={() => { const c = confirmDisconnect; setConfirmDisconnect(null); if (c) void act(c, "disconnect", { confirm: true, reason: "user" }); }}>{t("נתק", "Disconnect")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
