"use client";

import { useT } from "@/components/i18n/LangProvider";
import { LanguageToggle } from "@/components/i18n/LanguageToggle";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Bot, PhoneCall, BarChart3, FileText, Megaphone, MessageCircle, Settings, ShoppingCart, Star, Users, Zap } from "lucide-react";
import { useDialer } from "@/components/telephony/DialerProvider";
import { Badge, cx } from "@/components/ui";
// Rendered on the server too: bi() maps are Hebrew there, so the sidebar uses t() pairs to avoid a hydration mismatch.
const PRESENCE_PAIR: Record<string, [string, string]> = { offline: ["מנותק", "Offline"], available: ["זמין", "Available"], in_call: ["בשיחה", "In call"], wrap_up: ["בתיעוד", "Wrap-up"], paused: ["מושהה", "Paused"] };
import { api } from "@/lib/client/api";
import type { ModuleKey } from "@/lib/modules";
import type { EffectiveModule } from "@/lib/access/engine";
import { Lock, Menu, Shield } from "lucide-react";
import { ReportProblem } from "@/components/layout/ReportProblem";

type Role = "owner" | "manager" | "agent";
/** need = "module.action" strings; the item is shown when ANY of them is allowed for this user. */
interface Item { href: string; label: string; en: string; roles: Role[]; need?: string[]; Icon: typeof Star; match: (pathname: string) => boolean; testid: string }

const ALL: Role[] = ["agent", "manager", "owner"];
const MGMT: Role[] = ["manager", "owner"];

/**
 * Vertical side menu (right side in RTL) with five destinations only. Everything operational hangs off a page:
 * dial lists / dialer settings inside leads; audiences + templates inside campaigns; connections, numbers and users
 * behind the settings gear at the bottom.
 */
const ITEMS: Item[] = [
  { href: "/leads", label: "CRM", en: "CRM", roles: ALL, need: ["crm.view"], Icon: Star, testid: "nav-leads", match: (p) => p === "/leads" || p.startsWith("/leads/") || (p.startsWith("/contacts/") && !p.startsWith("/contacts/duplicates")) || p.startsWith("/deals") },
  // "חייגן": dial lists, call history and active calls (tabs), plus the running dialer screen.
  { href: "/calling/start", label: "חייגן", en: "Dialer", roles: ALL, need: ["telephony.use"], Icon: PhoneCall, testid: "nav-dial-campaigns", match: (p) => p.startsWith("/calling") || p === "/dialer" },
  { href: "/inbox", label: "שיחות וואטסאפ", en: "WhatsApp chats", roles: ALL, need: ["whatsapp.view"], Icon: MessageCircle, testid: "nav-inbox", match: (p) => p.startsWith("/inbox") },
  { href: "/contacts", label: "קהלים ואנשי קשר", en: "Audiences & contacts", roles: ALL, need: ["crm.view", "sms.draft", "email.draft", "whatsapp.campaign_draft"], Icon: Users, testid: "nav-contacts", match: (p) => p === "/contacts" || p.startsWith("/contacts/duplicates") || p.startsWith("/audiences") },
  { href: "/templates", label: "תבניות WhatsApp", en: "WhatsApp templates", roles: ALL, need: ["whatsapp.campaign_draft", "whatsapp.automations"], Icon: FileText, testid: "nav-templates", match: (p) => p.startsWith("/templates") },
  { href: "/campaigns/whatsapp", label: "הודעות תפוצה", en: "Broadcasts", roles: ALL, need: ["whatsapp.campaign_draft", "whatsapp.campaign_send", "sms.view", "email.view"], Icon: Megaphone, testid: "nav-campaigns", match: (p) => p.startsWith("/campaigns") },
  { href: "/automations", label: "אוטומציות", en: "Automations", roles: MGMT, need: ["whatsapp.automations", "sms.send", "email.send"], Icon: Zap, testid: "nav-automations", match: (p) => p.startsWith("/automations") || p.startsWith("/carts") },
  { href: "/ai", label: "מרכז ה־AI", en: "AI Center", roles: ALL, Icon: Bot, testid: "nav-ai", match: (p) => p.startsWith("/ai") },
  // "הצעות וסגירה" is no longer a menu item: offers open from the lead ("הצעת מחיר"), payment during a call from the
  // dialer, connections (payments / Meta) in settings → חיבורים. The /sales page itself still exists.
  { href: "/reports", label: "דוחות", en: "Reports", roles: MGMT, Icon: BarChart3, testid: "nav-reports", match: (p) => p.startsWith("/reports") || p.startsWith("/analytics") || p.startsWith("/manager") },
];

export function Sidebar({ user, businessName, businesses, modules, planName, access, platformAdmin }: { access: Record<ModuleKey, EffectiveModule>; platformAdmin: boolean; user: { fullName: string; role: string }; businessName: string; businesses: Array<{ id: string; name: string; active: boolean }>; modules: Record<ModuleKey, boolean>; planName: string | null }) {
  const t = useT();
  const pathname = usePathname();
  const { state, phone } = useDialer();
  const [switching, setSwitching] = useState(false);
  // Phones: the nav is a drawer opened from the top bar; it closes by itself on navigation (open "at" a path).
  const [openAt, setOpenAt] = useState<string | null>(null);
  const mobileOpen = openAt === pathname;
  const role = user.role as Role;
  const allowed = (need: string) => { const [m, a] = need.split(".") as [ModuleKey, string]; return access[m]?.state === "active" && access[m].actions.includes(a); };
  const anyModule = Object.values(access).some((x) => x.state === "active");
  const on = (m: ModuleKey) => access[m]?.state === "active";
  const moduleNames = [on("telephony") && t("טלפוניה", "Telephony"), (on("sms") || on("email")) && t("דיוור", "Campaigns"), on("whatsapp") && t("וואטסאפ", "WhatsApp"), on("crm") && "CRM"].filter(Boolean) as string[];
  const campaignsHref = allowed("whatsapp.campaign_draft") || allowed("whatsapp.campaign_send") ? "/campaigns/whatsapp" : allowed("sms.view") ? "/campaigns/sms" : "/campaigns/email";
  const items = ITEMS.filter((i) => i.roles.includes(role) && (i.need ? i.need.some(allowed) : anyModule)).map((i) => (i.testid === "nav-campaigns" ? { ...i, href: campaignsHref } : i));
  // Managers see what the package does not include (locked, with an upgrade request) – regular users never do.
  const locked = MGMT.includes(role) ? ITEMS.filter((i) => i.need && !items.includes(i) && i.need.every((n) => access[n.split(".")[0] as ModuleKey]?.state === "not_in_package")) : [];
  const manager = MGMT.includes(role);
  const presence = state?.presence ?? "offline";
  const presenceTone = presence === "in_call" ? "good" : presence === "available" ? "info" : presence === "wrap_up" || presence === "paused" ? "warn" : "neutral";
  const settingsActive = pathname.startsWith("/settings") || pathname.startsWith("/numbers");

  async function logout() {
    try {
      await api.post("/api/auth/logout");
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Authentication boundaries must discard the previous identity's module caches.
      window.location.assign("/login");
    }
    catch (e) { toast.error((e as Error).message); }
  }
  async function switchBusiness(businessId: string) {
    setSwitching(true);
    try {
      await api.post("/api/auth/switch", { businessId });
      // Tenant changes also reset useMe, status caches, drafts and the previous dialer provider.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- A client router refresh preserves the previous tenant's in-memory state.
      window.location.assign("/leads");
    }
    catch (e) { toast.error((e as Error).message); } finally { setSwitching(false); }
  }

  const activeName = businesses.find((b) => b.active)?.name ?? businessName;
  return (
    <>
    <div className="mobile-topbar bg-panel border-b border-line" data-testid="mobile-topbar">
      <button type="button" className="mobile-menu-btn" onClick={() => setOpenAt(pathname)} aria-label={t("פתיחת תפריט", "Open menu")} aria-expanded={mobileOpen} aria-controls="app-side-nav" data-testid="mobile-menu"><Menu size={22} aria-hidden /></button>
      <Link href="/leads" className="min-w-0 flex-1 truncate font-bold text-accent leading-[44px]">{activeName}</Link>
      {access.telephony?.state === "active" && <Badge tone={presenceTone} dot>{t(...(PRESENCE_PAIR[presence] ?? [presence, presence]))}</Badge>}
    </div>
    {mobileOpen && <div className="mobile-nav-backdrop" onClick={() => setOpenAt(null)} aria-hidden data-testid="mobile-nav-backdrop" />}
    <aside id="app-side-nav" className={cx("app-sidebar w-[256px] shrink-0 h-screen sticky top-0 bg-panel border-e border-line flex flex-col", mobileOpen && "open")} data-testid="side-nav"
      onKeyDown={(e) => { if (e.key === "Escape") setOpenAt(null); }} onClick={(e) => { if ((e.target as HTMLElement).closest("a[href]")) setOpenAt(null); }}>
      <div className="px-5 h-[74px] flex items-center gap-3 border-b border-line">
        <Link href="/" aria-label={t("למסך הבית", "Home")} title={t("למסך הבית", "Home")} data-testid="nav-home" className="shrink-0 w-9 h-9 rounded-lg bg-accent text-white font-extrabold text-lg inline-flex items-center justify-center hover:opacity-90">U</Link>
        <div className="min-w-0">
          {businesses.length > 1 ? (
            <select aria-label={t("בחירת עסק", "Select business")} className="bg-transparent font-bold text-xl leading-tight truncate text-accent w-full outline-none" value={businesses.find((b) => b.active)?.id} disabled={switching} onChange={(e) => switchBusiness(e.target.value)}>
              {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          ) : (
            <Link href="/leads" className="block font-bold text-xl leading-tight truncate text-accent hover:opacity-90" data-testid="nav-home-name">{businessName}</Link>
          )}
          <Link href="/leads" className="block text-[11px] text-muted hover:text-text">{t("CRM + תקשורת", "CRM + messaging")}{planName ? ` · ${planName}` : ""}</Link>
        </div>
      </div>
      <nav className="flex-1 px-2.5 py-5 space-y-0.5 overflow-y-auto" aria-label={t("ניווט ראשי", "Main navigation")}>
        {items.map((i) => {
          const active = i.match(pathname);
          return (
            <Link key={i.href} href={i.href} data-testid={i.testid} aria-current={active ? "page" : undefined} className={cx("flex items-center gap-3 px-3 h-10 rounded-lg text-sm transition-colors", active ? "bg-accent text-white" : "text-muted hover:text-text hover:bg-panel-2")}>
              <i.Icon size={17} aria-hidden />
              <span className="nav-label">{t(i.label, i.en)}</span>
            </Link>
          );
        })}
        {locked.map((i) => (
          <Link key={`locked-${i.href}`} href="/settings?tab=plan" data-testid={`${i.testid}-locked`} title={t("לא כלול בחבילה – לחצו לבקשת שדרוג", "Not in your plan – click to request an upgrade")} className="flex items-center gap-3 px-3 h-10 rounded-lg text-sm text-muted/60 hover:bg-panel-2">
            <Lock size={15} aria-hidden /><span className="nav-label">{t(i.label, i.en)}</span><span className="ms-auto text-[10px]">{t("לא בחבילה", "Not in plan")}</span>
          </Link>
        ))}
      </nav>
      <div className="p-3 border-t border-line space-y-2">
        {manager && (
          <Link href="/settings" data-testid="nav-settings" title={t("הגדרות, חיבורים, מספרים יוצאים, משתמשים והרשאות", "Settings, connections, numbers, users and permissions")} className={cx("flex items-center gap-3 px-3 h-10 rounded-lg text-sm transition-colors", settingsActive ? "bg-accent text-white" : "text-muted hover:text-text hover:bg-panel-2")}>
            <Settings size={17} aria-hidden /><span className="nav-label">{t("הגדרות", "Settings")}</span>
          </Link>
        )}
        {/* Platform administration: its own item right under settings – only for an authorized platform admin (the
            /platform pages and APIs check it on the server); never a tab inside the business's settings. */}
        {platformAdmin && (
          <Link href="/platform" data-testid="nav-platform" className={cx("flex items-center gap-3 px-3 h-10 rounded-lg text-sm transition-colors", pathname.startsWith("/platform") ? "bg-accent text-white" : "text-muted hover:text-text hover:bg-panel-2")}>
            <Shield size={17} aria-hidden /><span className="nav-label">{t("ניהול הפלטפורמה", "Platform administration")}</span>
          </Link>
        )}
        <div className="flex items-center justify-between gap-2 px-1">
          <a href="/account" className="min-w-0 hover:underline" data-testid="nav-my-account" title={t("החשבון שלי", "My account")}>
            <p className="text-sm font-medium truncate">{user.fullName}</p>
            <p className="text-[11px] text-muted">{role === "owner" ? t("בעלים בעסק זה", "Owner of this business") : role === "manager" ? t("מנהל בעסק זה", "Manager in this business") : t("נציג בעסק זה", "Agent in this business")}{platformAdmin ? ` · ${t("מנהל פלטפורמה", "Platform admin")}` : ""}</p>
          </a>
          {access.telephony?.state === "active" && <Badge tone={presenceTone} dot>{t(...(PRESENCE_PAIR[presence] ?? [presence, presence]))}</Badge>}
        </div>
        {/* The modules active for this user, in a fixed order ("דיוור" = SMS / email); with telephony, its connection status */}
        {moduleNames.length > 0 && (
          <div className="flex items-center justify-between gap-2 text-[11px] px-1">
            <span className="min-w-0 truncate text-muted" data-testid="nav-modules">{moduleNames.join(" | ")}</span>
            {access.telephony?.state === "active" && (
              <span title={t("מצב חיבור הטלפוניה", "Telephony connection status")} className={cx("shrink-0", phone.status === "ready" ? "text-good" : phone.status === "simulation" ? "text-warn" : phone.status === "connecting" ? "text-info" : "text-bad")}>
                {phone.status === "ready" ? t("מחובר", "Connected") : phone.status === "simulation" ? t("הדמיה", "Simulation") : phone.status === "connecting" ? t("מתחבר…", "Connecting…") : phone.status === "disconnected" ? t("מנותק", "Disconnected") : phone.status === "error" ? t("שגיאה", "Error") : "—"}
              </span>
            )}
          </div>
        )}
        <LanguageToggle className="w-full justify-center h-8 rounded-md text-muted hover:text-text hover:bg-panel-2" />
        <div className="text-center"><ReportProblem /></div>
        <button onClick={logout} data-testid="nav-logout" className="w-full h-8 rounded-md text-xs text-muted hover:text-text hover:bg-panel-2">{t("התנתקות", "Log out")}</button>
      </div>
    </aside>
    </>
  );
}
