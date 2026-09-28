"use client";

import { useT } from "@/components/i18n/LangProvider";
import { LanguageToggle } from "@/components/i18n/LanguageToggle";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Bot, PhoneCall, BarChart3, FileText, Megaphone, MessageCircle, Settings, ShoppingCart, Star, Users, Zap } from "lucide-react";
import { useDialer } from "@/components/telephony/DialerProvider";
import { Badge, cx } from "@/components/ui";
import { PRESENCE_LABEL } from "@/lib/client/format";
import { api } from "@/lib/client/api";
import type { ModuleKey } from "@/lib/modules";
import type { EffectiveModule } from "@/lib/access/engine";
import { Lock, Shield } from "lucide-react";
import { resetLeadStatusesCache } from "@/lib/client/use-lead-statuses";

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
  { href: "/leads", label: "CRM", en: "CRM", roles: ALL, need: ["crm.view"], Icon: Star, testid: "nav-leads", match: (p) => p === "/leads" || p.startsWith("/leads/") || (p.startsWith("/contacts/") && !p.startsWith("/contacts/duplicates")) || p === "/dialer" || p.startsWith("/deals") },
  { href: "/lists", label: "קמפיינים", en: "Dial campaigns", roles: ALL, need: ["telephony.use"], Icon: PhoneCall, testid: "nav-dial-campaigns", match: (p) => p.startsWith("/lists") },
  { href: "/inbox", label: "וואטסאפ", en: "WhatsApp", roles: ALL, need: ["whatsapp.view"], Icon: MessageCircle, testid: "nav-inbox", match: (p) => p.startsWith("/inbox") },
  { href: "/contacts", label: "קהלים ואנשי קשר", en: "Audiences & contacts", roles: ALL, need: ["crm.view", "sms.draft", "email.draft", "whatsapp.campaign_draft"], Icon: Users, testid: "nav-contacts", match: (p) => p === "/contacts" || p.startsWith("/contacts/duplicates") || p.startsWith("/audiences") },
  { href: "/templates", label: "תבניות WhatsApp", en: "WhatsApp templates", roles: ALL, need: ["whatsapp.campaign_draft", "whatsapp.automations"], Icon: FileText, testid: "nav-templates", match: (p) => p.startsWith("/templates") },
  { href: "/campaigns/whatsapp", label: "הודעות תפוצה", en: "Broadcasts", roles: ALL, need: ["whatsapp.campaign_draft", "whatsapp.campaign_send", "sms.view", "email.view"], Icon: Megaphone, testid: "nav-campaigns", match: (p) => p.startsWith("/campaigns") },
  { href: "/automations", label: "אוטומציות", en: "Automations", roles: MGMT, need: ["whatsapp.automations", "sms.send", "email.send"], Icon: Zap, testid: "nav-automations", match: (p) => p.startsWith("/automations") || p.startsWith("/carts") },
  { href: "/ai", label: "עוזר AI", en: "AI assistant", roles: ALL, Icon: Bot, testid: "nav-ai", match: (p) => p.startsWith("/ai") },
  { href: "/reports", label: "דוחות", en: "Reports", roles: MGMT, Icon: BarChart3, testid: "nav-reports", match: (p) => p.startsWith("/reports") || p.startsWith("/analytics") || p.startsWith("/manager") },
];

export function Sidebar({ user, businessName, businesses, modules, planName, access, platformAdmin }: { access: Record<ModuleKey, EffectiveModule>; platformAdmin: boolean; user: { fullName: string; role: string }; businessName: string; businesses: Array<{ id: string; name: string; active: boolean }>; modules: Record<ModuleKey, boolean>; planName: string | null }) {
  const t = useT();
  const pathname = usePathname();
  const router = useRouter();
  const { state, phone } = useDialer();
  const [switching, setSwitching] = useState(false);
  const role = user.role as Role;
  const allowed = (need: string) => { const [m, a] = need.split(".") as [ModuleKey, string]; return access[m]?.state === "active" && access[m].actions.includes(a); };
  const anyModule = Object.values(access).some((x) => x.state === "active");
  const campaignsHref = allowed("whatsapp.campaign_draft") || allowed("whatsapp.campaign_send") ? "/campaigns/whatsapp" : allowed("sms.view") ? "/campaigns/sms" : "/campaigns/email";
  const items = ITEMS.filter((i) => i.roles.includes(role) && (i.need ? i.need.some(allowed) : anyModule)).map((i) => (i.testid === "nav-campaigns" ? { ...i, href: campaignsHref } : i));
  // Managers see what the package does not include (locked, with an upgrade request) – regular users never do.
  const locked = MGMT.includes(role) ? ITEMS.filter((i) => i.need && !items.includes(i) && i.need.every((n) => access[n.split(".")[0] as ModuleKey]?.state === "not_in_package")) : [];
  const manager = MGMT.includes(role);
  const presence = state?.presence ?? "offline";
  const presenceTone = presence === "in_call" ? "good" : presence === "available" ? "info" : presence === "wrap_up" || presence === "paused" ? "warn" : "neutral";
  const settingsActive = pathname.startsWith("/settings") || pathname.startsWith("/numbers");

  async function logout() { await fetch("/api/auth/logout", { method: "POST" }); router.push("/login"); }
  async function switchBusiness(businessId: string) {
    setSwitching(true);
    try { await api.post("/api/auth/switch", { businessId }); resetLeadStatusesCache(); router.push("/leads"); router.refresh(); }
    catch (e) { toast.error((e as Error).message); } finally { setSwitching(false); }
  }

  return (
    <aside className="app-sidebar w-[256px] shrink-0 h-screen sticky top-0 bg-panel border-e border-line flex flex-col" data-testid="side-nav">
      <div className="px-5 h-[74px] flex items-center gap-3 border-b border-line">
        <Link href="/leads" aria-label={t("למסך הבית", "Home")} title={t("למסך הבית", "Home")} data-testid="nav-home" className="shrink-0 w-9 h-9 rounded-lg bg-accent text-white font-extrabold text-lg inline-flex items-center justify-center hover:opacity-90">U</Link>
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
        {platformAdmin && (
          <Link href="/platform" data-testid="nav-platform" className={cx("flex items-center gap-3 px-3 h-10 rounded-lg text-sm transition-colors mt-3", pathname.startsWith("/platform") ? "bg-accent text-white" : "text-muted hover:text-text hover:bg-panel-2")}>
            <Shield size={17} aria-hidden /><span className="nav-label">{t("ניהול פלטפורמה", "Platform admin")}</span>
          </Link>
        )}
      </nav>
      <div className="p-3 border-t border-line space-y-2">
        {manager && (
          <Link href="/settings" data-testid="nav-settings" title={t("הגדרות, חיבורים, מספרים יוצאים, משתמשים והרשאות", "Settings, connections, numbers, users and permissions")} className={cx("flex items-center gap-3 px-3 h-10 rounded-lg text-sm transition-colors", settingsActive ? "bg-accent text-white" : "text-muted hover:text-text hover:bg-panel-2")}>
            <Settings size={17} aria-hidden /><span className="nav-label">{t("הגדרות", "Settings")}</span>
          </Link>
        )}
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{user.fullName}</p>
            <p className="text-[11px] text-muted">{role === "owner" ? t("בעלים", "Owner") : role === "manager" ? t("מנהל", "Manager") : t("נציג", "Agent")}</p>
          </div>
          {access.telephony?.state === "active" && <Badge tone={presenceTone} dot>{PRESENCE_LABEL[presence]}</Badge>}
        </div>
        {access.telephony?.state === "active" && (
          <div className="flex items-center justify-between text-[11px] px-1">
            <span className="text-muted">{t("טלפוניה", "Telephony")}</span>
            <span className={cx(phone.status === "ready" ? "text-good" : phone.status === "simulation" ? "text-warn" : phone.status === "connecting" ? "text-info" : "text-bad")}>
              {phone.status === "ready" ? t("מחובר", "Connected") : phone.status === "simulation" ? t("הדמיה", "Simulation") : phone.status === "connecting" ? t("מתחבר…", "Connecting…") : phone.status === "disconnected" ? t("מנותק", "Disconnected") : phone.status === "error" ? t("שגיאה", "Error") : "—"}
            </span>
          </div>
        )}
        <LanguageToggle className="w-full justify-center h-8 rounded-md text-muted hover:text-text hover:bg-panel-2" />
        <button onClick={logout} data-testid="nav-logout" className="w-full h-8 rounded-md text-xs text-muted hover:text-text hover:bg-panel-2">{t("התנתקות", "Log out")}</button>
      </div>
    </aside>
  );
}
