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

type WaStatus = "disconnected" | "in_progress" | "needs_action" | "connected_not_ready" | "connected" | "revoked" | "error";

export interface ConnectionView {
  id: string; label: string | null; method: string; status: WaStatus; sendReady: boolean; receiveReady: boolean; blockers: string[];
  wabaId: string | null; wabaName: string | null; phoneNumberId: string | null; displayPhoneNumber: string | null; verifiedName: string | null; nameStatus: string | null;
  qualityRating: string | null; codeVerificationStatus: string | null; platformType: string | null; grantedScopes: unknown; isDefault: boolean; isActive: boolean;
  team: { id: string; name: string } | null; subscribedAt: string | null; registeredAt: string | null; tokenCheckedAt: string | null; lastCheckedAt: string | null;
  lastWebhookAt: string | null; lastOutboundTestAt: string | null; lastError: string | null; sendingBlocked: boolean; createdAt: string;
  testRecipients?: string[]; unitPrice?: number | null; unitPriceCurrency?: string | null;
}
export interface Overview {
  embeddedSignup: { ready: boolean; missing: string[]; appId: string | null; configId: string | null; version: string };
  pendingSession: { id: string; userId: string; createdAt: string } | null;
  connections: ConnectionView[];
}

const STATUS: Record<WaStatus, { label: string; tone: "default" | "secondary" | "destructive" | "outline"; className?: string }> = {
  disconnected: { label: "לא מחובר", tone: "outline" },
  in_progress: { label: "חיבור בתהליך", tone: "secondary" },
  needs_action: { label: "נדרשת פעולה ב-Meta", tone: "destructive", className: "bg-amber-500 text-black" },
  connected_not_ready: { label: "מחובר – לא מוכן", tone: "secondary", className: "bg-amber-100 text-amber-900" },
  connected: { label: "מחובר ופעיל", tone: "default", className: "bg-emerald-600 text-white" },
  revoked: { label: "ההרשאה בוטלה – נדרש חיבור מחדש", tone: "destructive" },
  error: { label: "תקלה", tone: "destructive" },
};

type Flow = { kind: "idle" } | { kind: "loading_sdk" } | { kind: "popup" } | { kind: "exchanging" } | { kind: "error"; message: string } | { kind: "cancelled"; step?: string };

declare global {
  interface Window {
    FB?: { init: (o: Record<string, unknown>) => void; login: (cb: (r: FbLoginResponse) => void, o: Record<string, unknown>) => void };
    fbAsyncInit?: () => void;
  }
}
interface FbLoginResponse { status?: string; authResponse?: { code?: string } | null }
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
function loadFbSdk(appId: string, version: string) {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.FB) return Promise.resolve();
  if (!sdkPromise) sdkPromise = new Promise<void>((resolve, reject) => {
    window.fbAsyncInit = () => { window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version }); resolve(); };
    const s = document.createElement("script");
    s.src = "https://connect.facebook.net/en_US/sdk.js"; s.async = true; s.defer = true; s.crossOrigin = "anonymous";
    s.onerror = () => { sdkPromise = null; reject(new Error("טעינת Facebook SDK נכשלה (חוסם פרסומות / רשת?)")); };
    document.body.appendChild(s);
    setTimeout(() => { if (!window.FB) { sdkPromise = null; reject(new Error("Facebook SDK לא נטען בזמן")); } }, 20_000);
  });
  return sdkPromise;
}

async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json?.error?.message ?? json?.error ?? json?.message ?? `שגיאה ${res.status}`), { code: json?.error?.code ?? json?.code, details: json?.error?.details ?? json?.details });
  return (json?.data ?? json) as T;
}

const fmt = (v: string | null) => (v ? new Date(v).toLocaleString("he-IL") : "—");

export function WhatsAppConnectCard({ initial, webhookUrl, canManage }: { initial: Overview; webhookUrl: string; canManage: boolean }) {
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
    try { setOverview(await api<Overview>("/api/whatsapp/connection")); router.refresh(); } catch (e) { toast.error((e as Error).message); }
  }, [router]);

  // Assets (waba/phone ids) arrive via postMessage; the code arrives via the FB.login callback. Both are needed.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!trustedOrigin(event.origin)) return;
      let data: unknown = event.data;
      if (typeof data === "string") { try { data = JSON.parse(data); } catch { return; } }
      if (!isEsMessage(data)) return;
      if (data.event === "FINISH" || data.event === "FINISH_ONLY_WABA" || data.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING") assetsRef.current = data.data;
      else if (data.event === "CANCEL") { setFlow({ kind: "cancelled", step: data.data.current_step }); void cancel(`cancelled at ${data.data.current_step ?? "?"}`, data.data.current_step); }
      else if (data.event === "ERROR") { setFlow({ kind: "error", message: data.data.error_message ?? "שגיאה בתהליך ההרשמה של Meta" }); void cancel(data.data.error_message ?? "error"); }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  async function cancel(reason: string, step?: string) {
    const state = stateRef.current; stateRef.current = null; inFlight.current = false;
    if (state) await api("/api/whatsapp/signup/cancel", { state, reason, step }).catch(() => undefined);
  }

  async function connect() {
    if (inFlight.current) return; // parallel flow prevention
    inFlight.current = true; assetsRef.current = null;
    try {
      setFlow({ kind: "loading_sdk" });
      const start = await api<SignupStart>("/api/whatsapp/signup/start", {});
      stateRef.current = start.state;
      await loadFbSdk(start.appId, start.version);
      setFlow({ kind: "popup" });
      const opened = await new Promise<FbLoginResponse>((resolve) => {
        window.FB!.login((r) => resolve(r), {
          config_id: start.configId, response_type: "code", override_default_response_type: true,
          extras: { setup: {}, sessionInfoVersion: "3", featureType: "" },
        });
      });
      const code = opened.authResponse?.code;
      if (!code) {
        // Closed without completing (cancel, or popup blocked → FB reports "unknown").
        const blocked = opened.status === "unknown" && !assetsRef.current;
        setFlow(blocked ? { kind: "error", message: "החלון של Meta לא נפתח או נסגר. בטל חסימת חלונות קופצים לאתר ונסה שוב." } : { kind: "cancelled" });
        await cancel(blocked ? "popup_blocked_or_closed" : "no_code");
        return;
      }
      // Wait briefly for the FINISH message (it can arrive just after the callback).
      for (let i = 0; i < 20 && !assetsRef.current; i++) await new Promise((r) => setTimeout(r, 100));
      const assets = assetsRef.current as EsMessage["data"] | null;
      if (!assets?.waba_id || !assets.phone_number_id) {
        setFlow({ kind: "error", message: "Meta לא החזירה מזהי חשבון/מספר. אם רק נוצר חשבון WABA ללא מספר – הוסף מספר ב-Meta ונסה שוב." });
        await cancel("missing_assets");
        return;
      }
      setFlow({ kind: "exchanging" });
      const result = await api<{ credentialId: string; status: WaStatus; step: string; error?: string }>("/api/whatsapp/signup/complete", {
        state: start.state, code, wabaId: assets.waba_id, phoneNumberId: assets.phone_number_id, metaBusinessId: assets.business_id,
      });
      stateRef.current = null;
      setFlow({ kind: "idle" });
      if (result.status === "connected") toast.success("החשבון חובר. בצע בדיקת שליחה וקבלה כדי לאשר מוכנות.");
      else toast.warning(result.error ?? `החיבור נשמר במצב: ${STATUS[result.status].label}`);
      await refresh();
    } catch (e) {
      const err = e as Error & { code?: string; details?: { missing?: string[] } };
      setFlow({ kind: "error", message: err.code === "scopes_missing" ? `${err.message}. חבר מחדש ואשר את כל ההרשאות המבוקשות.` : err.message });
      await cancel(err.message);
    } finally { inFlight.current = false; }
  }

  async function act(c: ConnectionView, action: "check" | "retry_setup" | "disconnect" | "test_send" | "settings", extra: Record<string, unknown> = {}) {
    if (busy) return;
    setBusy(`${c.id}:${action}`);
    try {
      const r = await api<{ status?: WaStatus; blockers?: string[]; error?: string | null; warning?: string | null; providerMessageId?: string | null }>(`/api/whatsapp/connection/${c.id}`, { action, ...extra });
      if (action === "check") { if (r.status === "connected") toast.success("החיבור תקין ומוכן"); else toast.warning(r.error ?? r.blockers?.join(" · ") ?? STATUS[r.status ?? "error"].label); }
      if (action === "retry_setup") { if (r.status === "connected") toast.success("ההגדרה הושלמה"); else toast.warning(r.error ?? "עדיין נדרשת פעולה"); }
      if (action === "disconnect") toast.success(r.warning ?? "החיבור נותק. ההיסטוריה נשמרה.");
      if (action === "test_send") toast.success(`הודעת בדיקה נשלחה${r.providerMessageId ? ` (${r.providerMessageId})` : ""}`);
      if ((action as string) === "settings") toast.success("הגדרות הבדיקה והעלות נשמרו");
      await refresh();
    } catch (e) { toast.error((e as Error).message); }
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
          <p className="mt-1 text-sm text-muted-foreground">חיבור חשבון הוואטסאפ העסקי לשליחה וקבלת הודעות בתוך UltraCRM</p>
        </div>
        <div className="flex items-center gap-2">
          {active.length === 0 && <Badge variant="outline">לא מחובר</Badge>}
          {canManage && (
            <Button onClick={connect} disabled={!es.ready || flowBusy} data-testid="wa-connect-btn">
              {flow.kind === "loading_sdk" ? "טוען…" : flow.kind === "popup" ? "ממתין ל-Meta…" : flow.kind === "exchanging" ? "מאמת ומגדיר…" : active.length ? "חבר חשבון נוסף" : "חבר WhatsApp"}
            </Button>
          )}
        </div>
      </div>

      {!es.ready && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="wa-missing-config">
          <div className="font-medium">החיבור באמצעות Meta Embedded Signup אינו זמין עדיין – חסרה הגדרה בשרת:</div>
          <ul className="mt-1 list-disc pe-5 font-mono text-xs">{es.missing.map((m) => <li key={m}><Ltr>{m}</Ltr></li>)}</ul>
          <div className="mt-2">ראו <span className="font-mono">docs/WHATSAPP_EMBEDDED_SIGNUP.md</span> להגדרת האפליקציה ב-Meta. עד אז ניתן להשתמש בחיבור הידני למטה.</div>
        </div>
      )}
      {!canManage && <p className="mt-3 text-sm text-muted-foreground">רק בעל העסק או מנהל מורשה יכולים לחבר, לבדוק או לנתק חשבון.</p>}

      {flow.kind === "popup" && <p className="mt-3 text-sm">נפתח חלון של Meta. השלם בו את בחירת החשבון והמספר ואשר את ההרשאות. אם לא נפתח חלון – בדוק חסימת חלונות קופצים.</p>}
      {flow.kind === "exchanging" && <p className="mt-3 text-sm">מחליף קוד הרשאה מול Meta, מאמת נכסים, נרשם לאירועים ורושם את המספר…</p>}
      {flow.kind === "cancelled" && <p className="mt-3 text-sm text-muted-foreground" data-testid="wa-flow-cancelled">התהליך בוטל{flow.step ? ` בשלב ${flow.step}` : ""}. לא בוצע שינוי.</p>}
      {flow.kind === "error" && <p className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive" data-testid="wa-flow-error">{flow.message}</p>}

      {active.map((c) => {
        const st = STATUS[c.status];
        return (
          <div key={c.id} className="mt-4 rounded-lg border p-4" data-testid={`wa-conn-${c.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={st.tone} className={st.className} data-testid="wa-status">{st.label}</Badge>
                {c.isDefault && <Badge variant="outline">ברירת מחדל</Badge>}
                <Badge variant="outline">{c.method === "embedded_signup" ? "Embedded Signup" : "חיבור ידני"}</Badge>
              </div>
              <div className="text-xs text-muted-foreground">נבדק לאחרונה: {fmt(c.lastCheckedAt)}</div>
            </div>
            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              <div className="flex gap-2"><dt className="text-muted-foreground">חשבון:</dt><dd>{c.wabaName ?? "—"} <span className="font-mono text-xs text-muted-foreground"><Ltr>{c.wabaId ?? ""}</Ltr></span></dd></div>
              <div className="flex gap-2"><dt className="text-muted-foreground">מספר:</dt><dd><Ltr>{c.displayPhoneNumber ?? c.phoneNumberId ?? "—"}</Ltr></dd></div>
              <div className="flex gap-2"><dt className="text-muted-foreground">שם מאומת:</dt><dd>{c.verifiedName ?? "—"} {c.nameStatus && <span className="text-xs text-muted-foreground">({c.nameStatus})</span>}</dd></div>
              <div className="flex gap-2"><dt className="text-muted-foreground">איכות:</dt><dd>{c.qualityRating ?? "—"}</dd></div>
              <div className="flex gap-2"><dt className="text-muted-foreground">שליחה:</dt><dd>{c.sendReady ? <span className="text-emerald-700">מוכן</span> : <span className="text-amber-700">לא מוכן</span>}{c.lastOutboundTestAt ? ` · בדיקת שליחה: ${fmt(c.lastOutboundTestAt)}` : " · טרם בוצעה בדיקת שליחה"}</dd></div>
              <div className="flex gap-2"><dt className="text-muted-foreground">קבלה:</dt><dd>{c.receiveReady ? <span className="text-emerald-700">רשום לאירועים</span> : <span className="text-amber-700">לא רשום</span>}{c.lastWebhookAt ? ` · אירוע אחרון: ${fmt(c.lastWebhookAt)}` : " · טרם התקבל אירוע מ-Meta"}</dd></div>
            </dl>
            {c.blockers.length > 0 && (
              <ul className="mt-3 list-disc pe-5 text-sm text-amber-800" data-testid="wa-blockers">{c.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
            )}
            {c.lastError && <p className="mt-2 text-sm text-destructive" data-testid="wa-last-error">{c.lastError}</p>}

            {canManage && (
              <div className="mt-4 flex flex-wrap items-end gap-2">
                <Button variant="outline" size="sm" onClick={() => act(c, "check")} disabled={busy !== null} data-testid="wa-check">{busy === `${c.id}:check` ? "בודק…" : "בדוק חיבור"}</Button>
                {(c.status === "needs_action" || c.status === "connected_not_ready" || c.status === "error") && c.method === "embedded_signup" && (
                  <Button variant="outline" size="sm" onClick={() => act(c, "retry_setup", pin ? { pin } : {})} disabled={busy !== null} data-testid="wa-retry">השלם הגדרה</Button>
                )}
                {c.method === "embedded_signup" && c.status === "needs_action" && /דו-שלבי|pin/i.test(c.lastError ?? "") && (
                  <div className="flex items-end gap-2">
                    <div><Label htmlFor={`pin-${c.id}`} className="text-xs">קוד אימות דו-שלבי (6 ספרות)</Label><Input id={`pin-${c.id}`} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" className="w-32" dir="ltr" /></div>
                  </div>
                )}
                {c.status === "revoked" || c.status === "error" || c.status === "needs_action" ? (
                  <Button variant="outline" size="sm" onClick={connect} disabled={!es.ready || flowBusy} data-testid="wa-reconnect">חבר מחדש</Button>
                ) : null}
                <Button variant="destructive" size="sm" onClick={() => setConfirmDisconnect(c)} disabled={busy !== null} data-testid="wa-disconnect">נתק</Button>
              </div>
            )}
            {canManage && (
              <div className="mt-3 flex flex-wrap items-end gap-2 border-t pt-3" data-testid="wa-settings">
                <div><Label htmlFor={`allow-${c.id}`} className="text-xs">מספרי בדיקה מורשים (מופרדים בפסיק) – שליחות בדיקה יוצאות רק אליהם</Label><Input id={`allow-${c.id}`} value={allow[c.id] ?? (c.testRecipients ?? []).join(", ")} onChange={(e) => setAllow({ ...allow, [c.id]: e.target.value })} dir="ltr" className="w-72" placeholder="+972501234567" /></div>
                <div><Label htmlFor={`price-${c.id}`} className="text-xs">מחיר ידני לשיחה שיווקית (לאומדן; ריק = לא ידוע)</Label><Input id={`price-${c.id}`} value={price[c.id] ?? (c.unitPrice?.toString() ?? "")} onChange={(e) => setPrice({ ...price, [c.id]: e.target.value })} dir="ltr" type="number" step="0.001" min="0" className="w-36" /></div>
                <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => act(c, "settings", { testRecipients: (allow[c.id] ?? (c.testRecipients ?? []).join(", ")).split(/[,\n]/).map((s) => s.trim()).filter(Boolean), unitPrice: (price[c.id] ?? c.unitPrice?.toString() ?? "") === "" ? null : Number(price[c.id] ?? c.unitPrice), unitPriceCurrency: "USD" })} data-testid="wa-save-settings">שמור הגדרות בדיקה ועלות</Button>
              </div>
            )}
            {canManage && c.sendReady && (
              <div className="mt-3 flex flex-wrap items-end gap-2 border-t pt-3">
                <div><Label htmlFor={`test-${c.id}`} className="text-xs">בדיקת שליחה למספר בדיקה בלבד (תבנית hello_world)</Label><Input id={`test-${c.id}`} value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="+9725…" className="w-48" dir="ltr" /></div>
                <Button variant="secondary" size="sm" onClick={() => act(c, "test_send", { to: testTo })} disabled={busy !== null || !testTo} data-testid="wa-test-send">שלח הודעת בדיקה</Button>
                <p className="w-full text-xs text-muted-foreground">שלח רק למספר בדיקה שבבעלותך. בדיקת קבלה: שלח הודעה מאותו מספר בדיקה אל המספר העסקי ובדוק ש&quot;אירוע אחרון&quot; מתעדכן.</p>
              </div>
            )}
          </div>
        );
      })}

      {history.length > 0 && (
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-muted-foreground">חיבורים קודמים ({history.length}) – ההיסטוריה נשמרת</summary>
          <ul className="mt-2 space-y-1">{history.map((c) => <li key={c.id} className="flex flex-wrap gap-2"><Badge variant="outline">{STATUS[c.status].label}</Badge><Ltr>{c.displayPhoneNumber ?? c.phoneNumberId ?? c.id}</Ltr><span className="text-muted-foreground">{c.wabaName ?? c.wabaId}</span>{canManage && c.method === "embedded_signup" && <Button variant="link" size="sm" className="h-auto p-0" onClick={connect} disabled={!es.ready || flowBusy}>חבר מחדש</Button>}</li>)}</ul>
        </details>
      )}

      <Separator className="my-4" />
      <div className="text-xs text-muted-foreground">
        <div>Webhook URL (מוגדר פעם אחת ברמת האפליקציה ב-Meta): <Ltr><code>{webhookUrl}</code></Ltr></div>
        <div className="mt-1">Graph API {es.version}{es.appId ? <> · App ID <Ltr><code>{es.appId}</code></Ltr></> : null}</div>
      </div>

      <AlertDialog open={confirmDisconnect !== null} onOpenChange={(o) => !o && setConfirmDisconnect(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>לנתק את {confirmDisconnect?.displayPhoneNumber ?? "החשבון"}?</AlertDialogTitle>
            <AlertDialogDescription>
              שליחת הודעות מהמספר תיפסק מיד והאפליקציה תפסיק לקבל אירועים עבורו. השיחות וההיסטוריה יישמרו. חשבון ה-WhatsApp והמספר עצמם לא נמחקים ב-Meta. ניתן לחבר מחדש בכל עת.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>ביטול</AlertDialogCancel>
            <AlertDialogAction data-testid="wa-disconnect-confirm" onClick={() => { const c = confirmDisconnect; setConfirmDisconnect(null); if (c) void act(c, "disconnect", { confirm: true, reason: "user" }); }}>נתק</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
