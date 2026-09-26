"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, Menu, Settings, X } from "lucide-react";
import { useDialer } from "@/components/telephony/DialerProvider";
import { Badge, cx } from "@/components/ui";
import { PRESENCE_LABEL } from "@/lib/client/format";
import { api } from "@/lib/client/api";
import type { ModuleKey } from "@/lib/modules";
import { resetLeadStatusesCache } from "@/lib/client/use-lead-statuses";

type Role = "owner" | "manager" | "agent";
interface Item { href: string; label: string; roles: Role[]; module?: ModuleKey; match: (pathname: string) => boolean; testid: string }

const ALL: Role[] = ["agent", "manager", "owner"];
const MGMT: Role[] = ["manager", "owner"];

/**
 * Five destinations, nothing else. Everything operational hangs off a page (dial lists / dialer settings inside
 * leads; audiences + templates inside campaigns; connections, numbers, users behind the settings gear).
 */
const ITEMS: Item[] = [
  { href: "/leads", label: "לידים", roles: ALL, module: "crm", testid: "nav-leads", match: (p) => p === "/leads" || p.startsWith("/leads/") || p.startsWith("/contacts") || p === "/dialer" || p.startsWith("/lists") || p.startsWith("/deals") },
  { href: "/inbox", label: "וואטסאפ", roles: ALL, module: "messaging", testid: "nav-inbox", match: (p) => p.startsWith("/inbox") },
  { href: "/campaigns/whatsapp", label: "קמפיינים", roles: MGMT, module: "messaging", testid: "nav-campaigns", match: (p) => p.startsWith("/campaigns") || p.startsWith("/audiences") || p.startsWith("/templates") },
  { href: "/automations", label: "אוטומציות", roles: MGMT, module: "messaging", testid: "nav-automations", match: (p) => p.startsWith("/automations") },
  { href: "/reports", label: "דוחות", roles: MGMT, testid: "nav-reports", match: (p) => p.startsWith("/reports") || p.startsWith("/analytics") || p.startsWith("/manager") },
];

export function TopNav({ user, businessName, businesses, modules, planName }: { user: { fullName: string; role: string }; businessName: string; businesses: Array<{ id: string; name: string; active: boolean }>; modules: Record<ModuleKey, boolean>; planName: string | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const { state, phone } = useDialer();
  const [switching, setSwitching] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false); // mobile drawer
  const [userOpen, setUserOpen] = useState(false); // user dropdown
  const userRef = useRef<HTMLDivElement>(null);
  const role = user.role as Role;
  const items = ITEMS.filter((i) => i.roles.includes(role) && (!i.module || modules[i.module]));
  const manager = MGMT.includes(role);
  const presence = state?.presence ?? "offline";
  const presenceTone = presence === "in_call" ? "good" : presence === "available" ? "info" : presence === "wrap_up" || presence === "paused" ? "warn" : "neutral";
  const phoneLabel = phone.status === "ready" ? "מחובר" : phone.status === "simulation" ? "הדמיה" : phone.status === "connecting" ? "מתחבר…" : phone.status === "disconnected" ? "מנותק" : phone.status === "error" ? "שגיאה" : "—";

  useEffect(() => { setMenuOpen(false); setUserOpen(false); }, [pathname]);
  useEffect(() => {
    if (!userOpen) return;
    const onDown = (e: MouseEvent) => { if (userRef.current && !userRef.current.contains(e.target as Node)) setUserOpen(false); };
    document.addEventListener("mousedown", onDown); return () => document.removeEventListener("mousedown", onDown);
  }, [userOpen]);

  async function logout() { await fetch("/api/auth/logout", { method: "POST" }); router.push("/login"); }
  async function switchBusiness(businessId: string) {
    setSwitching(true);
    try { await api.post("/api/auth/switch", { businessId }); resetLeadStatusesCache(); router.push("/leads"); router.refresh(); }
    catch (e) { toast.error((e as Error).message); } finally { setSwitching(false); }
  }
  const active = (i: Item) => i.match(pathname);

  return (
    <header className="top-nav" data-testid="top-nav">
      <div className="top-nav-inner">
        <Link href="/leads" className="top-nav-logo" aria-label={businessName}>
          <span className="top-nav-mark">U</span>
          <span className="top-nav-name">{businessName}</span>
        </Link>
        <nav className="top-nav-items" aria-label="ניווט ראשי">
          {items.map((i) => <Link key={i.href} href={i.href} data-testid={i.testid} className={cx("top-nav-item", active(i) && "active")} aria-current={active(i) ? "page" : undefined}>{i.label}</Link>)}
        </nav>
        <div className="top-nav-end">
          {modules.telephony && <Badge tone={presenceTone} dot>{PRESENCE_LABEL[presence]}</Badge>}
          {manager && <Link href="/settings" className={cx("top-nav-icon", pathname.startsWith("/settings") || pathname.startsWith("/numbers") ? "active" : "")} aria-label="הגדרות" title="הגדרות, חיבורים, מספרים, משתמשים" data-testid="nav-settings"><Settings size={18} /></Link>}
          <div className="top-nav-user" ref={userRef}>
            <button type="button" className="top-nav-user-btn" onClick={() => setUserOpen((o) => !o)} aria-haspopup="menu" aria-expanded={userOpen} data-testid="nav-user">
              <span className="top-nav-avatar" aria-hidden>{user.fullName.trim().charAt(0) || "?"}</span>
              <span className="top-nav-user-name">{user.fullName}</span>
              <ChevronDown size={14} />
            </button>
            {userOpen && (
              <div className="top-nav-menu" role="menu">
                <p className="top-nav-menu-title">{user.fullName}<span>{role === "owner" ? "בעלים" : role === "manager" ? "מנהל" : "נציג"}{planName ? ` · ${planName}` : ""}</span></p>
                {businesses.length > 1 && <label className="top-nav-menu-row">עסק<select aria-label="בחירת עסק" value={businesses.find((b) => b.active)?.id} disabled={switching} onChange={(e) => switchBusiness(e.target.value)}>{businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>}
                {modules.telephony && <p className="top-nav-menu-row">טלפוניה<span className={cx(phone.status === "ready" ? "text-good" : phone.status === "simulation" ? "text-warn" : phone.status === "connecting" ? "text-info" : "text-bad")}>{phoneLabel}</span></p>}
                {manager && <Link href="/settings" className="top-nav-menu-link" role="menuitem">הגדרות וחיבורים</Link>}
                <button type="button" className="top-nav-menu-link" role="menuitem" onClick={logout} data-testid="nav-logout">התנתקות</button>
              </div>
            )}
          </div>
          <button type="button" className="top-nav-burger" onClick={() => setMenuOpen((o) => !o)} aria-label={menuOpen ? "סגור תפריט" : "פתח תפריט"} aria-expanded={menuOpen} data-testid="nav-burger">{menuOpen ? <X size={20} /> : <Menu size={20} />}</button>
        </div>
      </div>
      {menuOpen && (
        <nav className="top-nav-mobile" aria-label="ניווט">
          {items.map((i) => <Link key={i.href} href={i.href} className={cx("top-nav-mobile-item", active(i) && "active")}>{i.label}</Link>)}
          {manager && <Link href="/settings" className="top-nav-mobile-item">הגדרות</Link>}
          <button type="button" className="top-nav-mobile-item" onClick={logout}>התנתקות</button>
        </nav>
      )}
    </header>
  );
}
