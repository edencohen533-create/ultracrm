"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Input, Modal, Panel, Select, Spinner } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

interface Account { id: string; accountId: string; name: string; currency: string | null; timezoneName: string | null; status: string; syncFrom: string | null; syncedThrough: string | null; lastSyncAt: string | null; lastSyncStatus: string | null; lastSyncError: string | null; nextSyncAt: string | null }
interface Status {
  connection: { kind: string; status: string; metaUserName: string | null; scopes: string[]; tokenExpiresAt: string | null; lastError: string | null; lastCheckedAt: string | null; verifiedAt: string } | null;
  accounts: Account[]; expiresSoon: boolean; canManage: boolean; encryptionReady: boolean;
  oauth: { ready: boolean; missing: string[]; redirectUri: string; configId: string | null };
}
interface Available { items: Array<{ accountId: string; name: string; currency: string | null; timezoneName: string | null; accountStatus: number | null; connected: boolean }>; manual: boolean }

const REASON: Record<string, [string, string]> = {
  oauth_denied: ["החיבור בוטל או נדחה ב-Meta.", "The connection was cancelled or denied at Meta."],
  scope_missing: ["לא ניתנה הרשאת ads_read – בלי הרשאה זו אין גישה לנתוני פרסום.", "ads_read wasn't granted – without it there's no access to ad data."],
  state_expired: ["בקשת החיבור פגה – נסו שוב.", "The connection request expired – try again."],
  meta_ads_not_configured: ["החיבור אינו מוגדר בשרת (פרטי אפליקציית Meta).", "The connection isn't configured on the server (Meta app details)."],
  action_denied: ["אין לך הרשאה לחבר חשבונות פרסום.", "You don't have permission to connect ad accounts."],
};
const ACC_STATUS: Record<string, [string, string, "good" | "warn" | "bad" | "neutral"]> = {
  active: ["פעיל", "Active", "good"], throttled: ["ממתין (מגבלת קצב של Meta)", "Waiting (Meta rate limit)", "warn"], auth_error: ["נדרש חיבור מחדש", "Reconnect needed", "bad"],
  no_access: ["אין הרשאה לחשבון", "No access to the account", "bad"], disconnected: ["מנותק (הנתונים נשמרו)", "Disconnected (data kept)", "neutral"], error: ["שגיאה", "Error", "bad"],
};

/** Settings → חיבורים → Meta Ads: measurement-only connection (read), real status from Meta, per-business accounts. */
export function MetaAdsPanel() {
  const t = useT(); const params = useSearchParams();
  const [st, setSt] = useState<Status | null>(null); const [denied, setDenied] = useState(false);
  const [pick, setPick] = useState<Available | null>(null); const [chosen, setChosen] = useState<string[]>([]); const [history, setHistory] = useState(90);
  const [manual, setManual] = useState(false); const [form, setForm] = useState({ accountId: "", accessToken: "" }); const [busy, setBusy] = useState("");
  const [help, setHelp] = useState(false);
  const load = useCallback(() => api.get<Status>("/api/integrations/meta-ads").then((s) => { setSt(s); setDenied(false); }).catch((e) => { if ((e as { status?: number }).status === 403 || /הרשאה/.test((e as Error).message)) setDenied(true); else toast.error((e as Error).message); }), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const r = params.get("metaAds");
    if (r === "connected") toast.success(t("חשבון Meta חובר – בחרו אילו חשבונות פרסום לשייך לעסק", "Meta connected – choose which ad accounts belong to this business"));
    if (r === "error") toast.error(t(...(REASON[params.get("reason") ?? ""] ?? ["החיבור לא הושלם.", "The connection wasn't completed."])));
  }, [params, t]);

  async function openPick() {
    setBusy("pick");
    try { const a = await api.get<Available>("/api/integrations/meta-ads/accounts"); setPick(a); setChosen(a.items.filter((x) => x.connected).map((x) => x.accountId)); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(""); }
  }
  async function saveAccounts() {
    setBusy("save");
    try { const s = await api.put<Status>("/api/integrations/meta-ads/accounts", { accountIds: chosen, historyDays: history }); setSt(s); setPick(null); toast.success(t("החשבונות נשמרו – הסנכרון ההיסטורי מתחיל", "Accounts saved – the history sync is starting")); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(""); }
  }
  async function syncNow() {
    setBusy("sync");
    try { const r = await api.post<{ status: Status }>("/api/integrations/meta-ads/sync", {}); setSt(r.status); toast.success(t("הסנכרון רץ – הנתונים מתעדכנים", "Sync ran – data is updating")); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(""); }
  }
  async function connectManual() {
    setBusy("manual");
    try { await api.post("/api/integrations/meta-ads/manual", form); setManual(false); setForm({ accountId: "", accessToken: "" }); await load(); toast.success(t("החשבון אומת מול Meta וחובר", "The account was verified with Meta and connected")); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(""); }
  }
  async function disconnect(deleteData: boolean) {
    if (!confirm(deleteData ? t("לנתק ולמחוק את נתוני הפרסום שסונכרנו לעסק הזה?", "Disconnect and delete the synced ad data of this business?") : t("לנתק את חשבון Meta? נתוני העבר יישמרו והסנכרון ייעצר.", "Disconnect Meta? Past data is kept and syncing stops."))) return;
    setBusy("disc");
    try { await api.delete(`/api/integrations/meta-ads${deleteData ? "?deleteData=1" : ""}`); await load(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(""); }
  }

  const loc = t.lang === "en" ? "en-GB" : "he-IL";
  const dt = (s: string | null) => (s ? new Date(s).toLocaleString(loc, { dateStyle: "short", timeStyle: "short" }) : "—");
  if (denied) return <Panel title={t("Meta Ads – מודעות ולידים", "Meta Ads – ads & leads")}><p className="text-sm text-muted">{t("החיבור מנוהל על ידי בעל העסק או מנהל עם הרשאת \"חיבור חשבונות פרסום\".", "The connection is managed by the owner or a manager with the \"Connect ad accounts\" permission.")}</p></Panel>;
  if (!st) return <Panel title={t("Meta Ads – מודעות ולידים", "Meta Ads – ads & leads")}><Spinner /></Panel>;
  const c = st.connection;
  const connStatus = !c ? null : c.status === "active" ? <Badge tone="good" dot>{t("מחובר", "Connected")}</Badge> : c.status === "revoked" ? <Badge tone="bad" dot>{t("ההרשאה הוסרה ב-Meta", "Permission removed at Meta")}</Badge> : <Badge tone="bad" dot>{t("פג תוקף – נדרש חיבור מחדש", "Expired – reconnect needed")}</Badge>;

  return (
    <div id="meta-ads">
    <Panel title={<span className="flex items-center gap-2">{t("Meta Ads – מודעות ולידים", "Meta Ads – ads & leads")} {connStatus}</span>} actions={<button type="button" className="text-xs underline text-muted" onClick={() => setHelp(true)} data-testid="meta-ads-help">{t("איך מגיעים נתוני מקור?", "How does source data arrive?")}</button>}>
      <div className="space-y-3 text-sm" data-testid="meta-ads-panel">
        <p className="text-muted text-xs">{t("חיבור למדידה בלבד: קריאת הוצאות, חשיפות, קליקים ולידים לפי מודעה. המערכת לא יוצרת מודעות, לא משנה תקציבים ולא משהה קמפיינים. חיבור WhatsApp אינו נותן גישה לנתוני פרסום.", "Measurement only: reads spend, impressions, clicks and leads per ad. The system never creates ads, changes budgets or pauses campaigns. A WhatsApp connection gives no access to ad data.")}</p>
        {c ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span>{c.kind === "oauth" ? t(`התחברות Meta${c.metaUserName ? ` – ${c.metaUserName}` : ""}`, `Meta login${c.metaUserName ? ` – ${c.metaUserName}` : ""}`) : t("אסימון משתמש מערכת (ידני)", "System-user token (manual)")}</span>
            <span className="text-muted">{t("הרשאות:", "Permissions:")} <span className="ltr">{c.scopes.join(", ") || "—"}</span></span>
            {c.tokenExpiresAt && <span className={st.expiresSoon ? "text-warn" : "text-muted"}>{t("תוקף עד", "Valid until")} {dt(c.tokenExpiresAt)}</span>}
            <span className="text-muted">{t("נבדק לאחרונה", "Last checked")} {dt(c.lastCheckedAt ?? c.verifiedAt)}</span>
            {c.lastError && c.status !== "active" && <span className="text-bad">{c.lastError}</span>}
          </div>
        ) : <p>{t("לא מחובר חשבון פרסום. חברו כדי לראות הוצאות, עלות ללקוח ו-ROAS בדוח \"שיווק ומכירות\".", "No ad account connected. Connect to see spend, cost per customer and ROAS in the \"Marketing & sales\" report.")}</p>}

        {st.canManage && (
          <div className="flex flex-wrap gap-2">
            {st.oauth.ready ? <a href="/api/integrations/meta-ads/oauth/start" className="inline-flex items-center h-8 px-3 rounded-md text-xs font-medium bg-accent text-white" data-testid="meta-ads-oauth">{c ? t("חבר מחדש עם Meta", "Reconnect with Meta") : t("חבר חשבון פרסום", "Connect ad account")}</a>
              : <span className="text-xs text-muted" data-testid="meta-ads-oauth-missing">{t(`התחברות דרך Meta אינה זמינה – חסר בשרת: ${st.oauth.missing.join(", ")}`, `Meta login unavailable – missing on the server: ${st.oauth.missing.join(", ")}`)}</span>}
            <Button size="sm" variant="secondary" onClick={() => setManual(true)} data-testid="meta-ads-manual-open">{t("חיבור עם אסימון (מתקדם)", "Connect with a token (advanced)")}</Button>
            {c && c.status === "active" && c.kind === "oauth" && <Button size="sm" variant="secondary" onClick={openPick} loading={busy === "pick"} data-testid="meta-ads-pick">{t("בחירת חשבונות פרסום", "Choose ad accounts")}</Button>}
            {st.accounts.some((a) => a.status === "active" || a.status === "throttled") && <Button size="sm" variant="secondary" onClick={syncNow} loading={busy === "sync"} data-testid="meta-ads-sync">{t("סנכרן עכשיו", "Sync now")}</Button>}
            {c && <Button size="sm" variant="ghost" className="text-bad" onClick={() => disconnect(false)} loading={busy === "disc"}>{t("נתק", "Disconnect")}</Button>}
            {!c && st.accounts.length > 0 && <Button size="sm" variant="ghost" className="text-bad" onClick={() => disconnect(true)}>{t("מחק נתוני פרסום שסונכרנו", "Delete synced ad data")}</Button>}
          </div>
        )}

        {st.accounts.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[640px]" data-testid="meta-ads-accounts">
              <thead className="text-muted"><tr><th className="text-start py-1.5">{t("חשבון פרסום", "Ad account")}</th><th className="text-start">{t("מצב", "Status")}</th><th className="text-start">{t("מטבע / אזור זמן", "Currency / time zone")}</th><th className="text-start">{t("נתונים עד", "Data through")}</th><th className="text-start">{t("סנכרון אחרון", "Last sync")}</th></tr></thead>
              <tbody className="divide-y divide-line">
                {st.accounts.map((a) => { const s = ACC_STATUS[a.status] ?? [a.status, a.status, "neutral" as const]; return (
                  <tr key={a.id}>
                    <td className="py-1.5">{a.name} <span className="text-muted ltr">act_{a.accountId}</span></td>
                    <td><Badge tone={s[2]}>{t(s[0], s[1])}</Badge>{a.nextSyncAt && a.status === "throttled" && <span className="text-muted ms-1">{t("ינסה שוב ב-", "retries at ")}{dt(a.nextSyncAt)}</span>}</td>
                    <td className="ltr text-start">{a.currency ?? "—"} · {a.timezoneName ?? "—"}</td>
                    <td>{a.syncedThrough ? `${a.syncFrom?.slice(0, 10)} → ${a.syncedThrough.slice(0, 10)}` : t(`ממתין (מ-${a.syncFrom?.slice(0, 10) ?? "—"})`, `Pending (from ${a.syncFrom?.slice(0, 10) ?? "—"})`)}</td>
                    <td>{dt(a.lastSyncAt)}{a.lastSyncStatus && a.lastSyncStatus !== "ok" && <span className="text-bad ms-1" title={a.lastSyncError ?? ""}>· {a.lastSyncError?.slice(0, 60)}</span>}</td>
                  </tr>
                ); })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs"><Link href="/reports/marketing" className="underline text-accent">{t("לדוח שיווק ומכירות ←", "Open the marketing & sales report →")}</Link></p>
      </div>

      <Modal open={Boolean(pick)} onClose={() => setPick(null)} title={t("אילו חשבונות פרסום שייכים לעסק הזה?", "Which ad accounts belong to this business?")} footer={<><Button variant="ghost" onClick={() => setPick(null)}>{t("ביטול", "Cancel")}</Button><Button onClick={saveAccounts} loading={busy === "save"} data-testid="meta-ads-save-accounts">{t("שמור", "Save")}</Button></>}>
        <div className="space-y-2 text-sm">
          {pick?.items.length === 0 && <p className="text-muted">{t("החיבור לא רואה חשבונות פרסום. ודאו שלמשתמש יש גישה לחשבון ב-Business Manager.", "The login sees no ad accounts. Make sure the user has access to the account in Business Manager.")}</p>}
          {pick?.items.map((a) => (
            <label key={a.accountId} className="flex items-center gap-2"><input type="checkbox" checked={chosen.includes(a.accountId)} onChange={(e) => setChosen(e.target.checked ? [...chosen, a.accountId] : chosen.filter((x) => x !== a.accountId))} /> {a.name} <span className="text-muted text-xs ltr">act_{a.accountId} · {a.currency} · {a.timezoneName}</span></label>
          ))}
          <Select label={t("טווח סנכרון היסטורי", "History to sync")} value={String(history)} onChange={(e) => setHistory(Number(e.target.value))}>
            {[30, 90, 180, 365, 730].map((d) => <option key={d} value={d}>{t(`${d} ימים אחרונים`, `Last ${d} days`)}</option>)}
          </Select>
          <p className="text-xs text-muted">{t("חשבון שלא נבחר מפסיק להסתנכרן; הנתונים שכבר נשמרו נשארים.", "An unselected account stops syncing; data already stored is kept.")}</p>
        </div>
      </Modal>

      <Modal open={manual} onClose={() => setManual(false)} title={t("חיבור עם אסימון משתמש מערכת", "Connect with a system-user token")} footer={<><Button variant="ghost" onClick={() => setManual(false)}>{t("ביטול", "Cancel")}</Button><Button onClick={connectManual} loading={busy === "manual"} disabled={!form.accountId || form.accessToken.length < 10}>{t("אמת וחבר", "Verify & connect")}</Button></>}>
        <div className="space-y-3 text-sm">
          <p className="text-xs text-muted">{t("ב-Business Manager: הגדרות עסק ← משתמשי מערכת ← יצירת אסימון עם הרשאת ads_read בלבד, ושיוך חשבון הפרסום למשתמש המערכת. האסימון נשמר מוצפן בשרת ואינו מוצג שוב.", "In Business Manager: Business settings → System users → generate a token with ads_read only, and assign the ad account to the system user. The token is stored encrypted on the server and never shown again.")}</p>
          <Input label={t("מזהה חשבון פרסום", "Ad account ID")} placeholder="act_123456789" value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value.trim() })} ltr />
          <Input label={t("אסימון גישה", "Access token")} type="password" autoComplete="off" value={form.accessToken} onChange={(e) => setForm({ ...form, accessToken: e.target.value.trim() })} ltr />
        </div>
      </Modal>

      <Modal open={help} onClose={() => setHelp(false)} title={t("איך מגיע מקור הליד", "How lead source data arrives")} width="max-w-2xl">
        <div className="space-y-3 text-sm" data-testid="meta-ads-source-help">
          <p>{t("שיוך למודעה מתבסס רק על מזהים מספריים שנשמרים בפנייה (מזהה מודעה / קבוצת מודעות / קמפיין). שם קמפיין או UTM לבדו לא משייך למודעה.", "Attribution to an ad relies only on numeric ids saved with the inquiry (ad / ad set / campaign id). A campaign name or UTM alone never attributes to an ad.")}</p>
          <div><b>{t("1. מודעות שמובילות לדף נחיתה", "1. Ads that lead to a landing page")}</b><p className="text-muted text-xs">{t("ב-Ads Manager ← מודעה ← \"פרמטרים של כתובת URL\" הוסיפו:", "In Ads Manager → ad → \"URL parameters\" add:")}</p><pre className="ltr text-start bg-panel-2 rounded p-2 text-xs overflow-x-auto">utm_source=facebook&amp;utm_medium=paid&amp;utm_campaign={"{{campaign.name}}"}&amp;utm_content={"{{ad.name}}"}&amp;ad_id={"{{ad.id}}"}&amp;adset_id={"{{adset.id}}"}&amp;campaign_id={"{{campaign.id}}"}</pre><p className="text-muted text-xs">{t("בטופס בדף הנחיתה שלחו את הפרמטרים האלה (ואת fbclid וכתובת הדף) יחד עם הליד ל-POST /api/v1/leads בשדה attribution.", "On the landing-page form, send these parameters (plus fbclid and the page URL) with the lead to POST /api/v1/leads in the attribution field.")}</p></div>
          <div><b>{t("2. טפסי לידים של Meta (Lead Ads)", "2. Meta Lead Ads forms")}</b><p className="text-muted text-xs">{t("דרך Make / Zapier: בחיבור \"New Lead\" של Facebook Lead Ads מפו את ad_id, adset_id, campaign_id, form_id ו-leadgen_id לשדה attribution של POST /api/v1/leads. אותו ליד שנשלח פעמיים נספר פעם אחת (לפי leadgen_id). קליטה ישירה מ-Meta ללא Make/Zapier דורשת הרשאת leads_retrieval ואישור אפליקציה – אינה פעילה כרגע.", "Via Make / Zapier: in the Facebook Lead Ads \"New Lead\" trigger map ad_id, adset_id, campaign_id, form_id and leadgen_id into the attribution field of POST /api/v1/leads. The same lead sent twice counts once (by leadgen_id). Direct intake from Meta without Make/Zapier needs the leads_retrieval permission and app review – not active yet.")}</p></div>
          <div><b>{t("3. מודעות לוואטסאפ (Click-to-WhatsApp)", "3. Click-to-WhatsApp ads")}</b><p className="text-muted text-xs">{t("נקלט אוטומטית: ההודעה הראשונה מהמודעה מגיעה עם מזהה המודעה ונשמרת כפנייה. דורש חיבור WhatsApp Cloud API פעיל.", "Automatic: the first message from the ad arrives with the ad id and is recorded as an inquiry. Requires an active WhatsApp Cloud API connection.")}</p></div>
          <div><b>{t("4. ייבוא קובץ", "4. File import")}</b><p className="text-muted text-xs">{t("עמודות ad_id / adset_id / campaign_id (מספרים) משייכות למודעה. עמודות שם קמפיין / מודעה נשמרות כמידע בלבד.", "ad_id / adset_id / campaign_id columns (numbers) attribute to an ad. Campaign / ad name columns are kept as information only.")}</p></div>
          <div><b>{t("5. יצירה ידנית", "5. Created manually")}</b><p className="text-muted text-xs">{t("נשמרת כפנייה ידנית ללא מודעה (אלא אם איש הקשר הגיע קודם עם מזהי מודעה).", "Recorded as a manual inquiry without an ad (unless the contact arrived earlier with ad ids).")}</p></div>
        </div>
      </Modal>
    </Panel>
    </div>
  );
}
