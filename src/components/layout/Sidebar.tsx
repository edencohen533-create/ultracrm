"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { BarChart3, FileText, Megaphone, MessageCircle, Settings, Star, Users, Zap } from "lucide-react";
import { useDialer } from "@/components/telephony/DialerProvider";
import { Badge, cx } from "@/components/ui";
import { PRESENCE_LABEL } from "@/lib/client/format";
import { api } from "@/lib/client/api";
import type { ModuleKey } from "@/lib/modules";
import { resetLeadStatusesCache } from "@/lib/client/use-lead-statuses";

type Role = "owner" | "manager" | "agent";
interface Item { href: string; label: string; roles: Role[]; module?: ModuleKey; Icon: typeof Star; match: (pathname: string) => boolean; testid: string }

const ALL: Role[] = ["agent", "manager", "owner"];
const MGMT: Role[] = ["manager", "owner"];

/**
 * Vertical side menu (right side in RTL) with five destinations only. Everything operational hangs off a page:
 * dial lists / dialer settings inside leads; audiences + templates inside campaigns; connections, numbers and users
 * behind the settings gear at the bottom.
 */
const ITEMS: Item[] = [
  { href: "/leads", label: "לידים", roles: ALL, module: "crm", Icon: Star, testid: "nav-leads", match: (p) => p === "/leads" || p.startsWith("/leads/") || (p.startsWith("/contacts/") && !p.startsWith("/contacts/duplicates")) || p === "/dialer" || p.startsWith("/lists") || p.startsWith("/deals") },
  { href: "/inbox", label: "וואטסאפ", roles: ALL, module: "messaging", Icon: MessageCircle, testid: "nav-inbox", match: (p) => p.startsWith("/inbox") },
  { href: "/contacts", label: "קהלים ואנשי קשר", roles: ALL, module: "crm", Icon: Users, testid: "nav-contacts", match: (p) => p === "/contacts" || p.startsWith("/contacts/duplicates") || p.startsWith("/audiences") },
  { href: "/templates", label: "תבניות WhatsApp", roles: MGMT, module: "messaging", Icon: FileText, testid: "nav-templates", match: (p) => p.startsWith("/templates") },
  { href: "/campaigns/whatsapp", label: "קמפיינים", roles: MGMT, module: "messaging", Icon: Megaphone, testid: "nav-campaigns", match: (p) => p.startsWith("/campaigns") },
  { href: "/automations", label: "אוטומציות", roles: MGMT, module: "messaging", Icon: Zap, testid: "nav-automations", match: (p) => p.startsWith("/automations") },
  { href: "/reports", label: "דוחות", roles: MGMT, Icon: BarChart3, testid: "nav-reports", match: (p) => p.startsWith("/reports") || p.startsWith("/analytics") || p.startsWith("/manager") },
];

export function Sidebar({ user, businessName, businesses, modules, planName }: { user: { fullName: string; role: string }; businessName: string; businesses: Array<{ id: string; name: string; active: boolean }>; modules: Record<ModuleKey, boolean>; planName: string | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const { state, phone } = useDialer();
  const [switching, setSwitching] = useState(false);
  const role = user.role as Role;
  const items = ITEMS.filter((i) => i.roles.includes(role) && (!i.module || modules[i.module]));
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
        <div className="min-w-0">
          {businesses.length > 1 ? (
            <select aria-label="בחירת עסק" className="bg-transparent font-bold text-xl leading-tight truncate text-accent w-full outline-none" value={businesses.find((b) => b.active)?.id} disabled={switching} onChange={(e) => switchBusiness(e.target.value)}>
              {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          ) : (
            <p className="font-bold text-xl leading-tight truncate text-accent">{businessName}</p>
          )}
          <p className="text-[11px] text-muted">CRM + תקשורת{planName ? ` · ${planName}` : ""}</p>
        </div>
      </div>
      <nav className="flex-1 px-2.5 py-5 space-y-0.5 overflow-y-auto" aria-label="ניווט ראשי">
        {items.map((i) => {
          const active = i.match(pathname);
          return (
            <Link key={i.href} href={i.href} data-testid={i.testid} aria-current={active ? "page" : undefined} className={cx("flex items-center gap-3 px-3 h-10 rounded-lg text-sm transition-colors", active ? "bg-accent text-white" : "text-muted hover:text-text hover:bg-panel-2")}>
              <i.Icon size={17} aria-hidden />
              <span className="nav-label">{i.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="p-3 border-t border-line space-y-2">
        {manager && (
          <Link href="/settings" data-testid="nav-settings" title="הגדרות, חיבורים, מספרים יוצאים, משתמשים והרשאות" className={cx("flex items-center gap-3 px-3 h-10 rounded-lg text-sm transition-colors", settingsActive ? "bg-accent text-white" : "text-muted hover:text-text hover:bg-panel-2")}>
            <Settings size={17} aria-hidden /><span className="nav-label">הגדרות</span>
          </Link>
        )}
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{user.fullName}</p>
            <p className="text-[11px] text-muted">{role === "owner" ? "בעלים" : role === "manager" ? "מנהל" : "נציג"}</p>
          </div>
          {modules.telephony && <Badge tone={presenceTone} dot>{PRESENCE_LABEL[presence]}</Badge>}
        </div>
        {modules.telephony && (
          <div className="flex items-center justify-between text-[11px] px-1">
            <span className="text-muted">טלפוניה</span>
            <span className={cx(phone.status === "ready" ? "text-good" : phone.status === "simulation" ? "text-warn" : phone.status === "connecting" ? "text-info" : "text-bad")}>
              {phone.status === "ready" ? "מחובר" : phone.status === "simulation" ? "הדמיה" : phone.status === "connecting" ? "מתחבר…" : phone.status === "disconnected" ? "מנותק" : phone.status === "error" ? "שגיאה" : "—"}
            </span>
          </div>
        )}
        <button onClick={logout} data-testid="nav-logout" className="w-full h-8 rounded-md text-xs text-muted hover:text-text hover:bg-panel-2">התנתקות</button>
      </div>
    </aside>
  );
}
