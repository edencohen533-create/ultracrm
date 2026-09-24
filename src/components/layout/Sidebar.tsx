"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { useDialer } from "@/components/telephony/DialerProvider";
import { Badge, cx } from "@/components/ui";
import { PRESENCE_LABEL } from "@/lib/client/format";
import { api } from "@/lib/client/api";
import type { ModuleKey } from "@/lib/modules";

type Role = "owner" | "manager" | "agent";

interface Item {
  href: string;
  label: string;
  roles: Role[];
  module?: ModuleKey;
  icon: string;
  match?: (pathname: string) => boolean;
}

interface Section {
  title: string;
  items: Item[];
}

const ICON = {
  dashboard: "M3 13h8V3H3v10zm10 8h8V11h-8v10zM3 21h8v-6H3v6zm10-18v6h8V3h-8z",
  contacts: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  leads: "M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z",
  deals: "M3 3v18h18M7 14l4-4 4 4 5-6",
  tasks: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  inbox: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  campaigns: "M3 11l18-5v12L3 14v-3zM11.6 16.8a3 3 0 1 1-5.8-1.6",
  templates: "M4 4h16v16H4zM8 8h8M8 12h8M8 16h5",
  automations: "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
  dialer: "M2 5.5A2.5 2.5 0 0 1 4.5 3h2l2 5-2.5 1.5a11 11 0 0 0 5.5 5.5L13 12.5l5 2v2A2.5 2.5 0 0 1 15.5 19 13.5 13.5 0 0 1 2 5.5z",
  lists: "M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2",
  manager: "M3 3v18h18M7 14l4-4 4 4 5-6",
  history: "M12 8v4l3 3M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
};

const ALL: Role[] = ["agent", "manager", "owner"];
const MGMT: Role[] = ["manager", "owner"];

const SECTIONS: Section[] = [
  {
    title: "CRM",
    items: [
      { href: "/dashboard", label: "דשבורד", roles: ALL, icon: ICON.dashboard },
      { href: "/contacts", label: "אנשי קשר", roles: ALL, module: "crm", icon: ICON.contacts },
      { href: "/leads", label: "לידים", roles: ALL, module: "crm", icon: ICON.leads },
      { href: "/deals", label: "עסקאות", roles: ALL, module: "crm", icon: ICON.deals },
      { href: "/tasks", label: "משימות", roles: ALL, module: "crm", icon: ICON.tasks },
    ],
  },
  {
    title: "דיוור",
    items: [
      { href: "/inbox", label: "תיבת הודעות", roles: ALL, module: "messaging", icon: ICON.inbox },
      { href: "/campaigns", label: "קמפיינים וקהלים", roles: MGMT, module: "messaging", icon: ICON.campaigns },
      { href: "/templates", label: "תבניות", roles: ALL, module: "messaging", icon: ICON.templates },
      { href: "/automations", label: "אוטומציות דיוור", roles: MGMT, module: "messaging", icon: ICON.automations },
    ],
  },
  {
    title: "טלפוניה",
    items: [
      { href: "/dialer", label: "חייגן", roles: ALL, module: "telephony", icon: ICON.dialer },
      { href: "/lists", label: "רשימות חיוג", roles: ALL, module: "telephony", icon: ICON.lists },
      { href: "/manager", label: "מוקד בזמן אמת", roles: MGMT, module: "telephony", icon: ICON.manager, match: (p) => p === "/manager" },
      { href: "/manager/calls", label: "היסטוריית שיחות", roles: MGMT, module: "telephony", icon: ICON.history },
      { href: "/numbers", label: "מספרים יוצאים", roles: MGMT, module: "telephony", icon: ICON.settings },
    ],
  },
  {
    title: "ניהול",
    items: [{ href: "/settings", label: "הגדרות", roles: MGMT, icon: ICON.settings }],
  },
];

export function Sidebar({ user, businessName, businesses, modules, planName }: { user: { fullName: string; role: string }; businessName: string; businesses: Array<{ id: string; name: string; active: boolean }>; modules: Record<ModuleKey, boolean>; planName: string | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const { state, phone } = useDialer();
  const [switching, setSwitching] = useState(false);
  const presence = state?.presence ?? "offline";
  const presenceTone = presence === "in_call" ? "good" : presence === "available" ? "info" : presence === "wrap_up" ? "warn" : presence === "paused" ? "warn" : "neutral";

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  async function switchBusiness(businessId: string) {
    setSwitching(true);
    try {
      await api.post("/api/auth/switch", { businessId });
      router.push("/dashboard");
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSwitching(false);
    }
  }

  return (
    <aside className="w-[228px] shrink-0 h-screen sticky top-0 bg-panel border-s border-line flex flex-col">
      <div className="px-4 h-14 flex items-center gap-3 border-b border-line">
        <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center text-white font-bold">U</div>
        <div className="min-w-0">
          {businesses.length > 1 ? (
            <select
              aria-label="בחירת עסק"
              className="bg-transparent font-semibold text-sm leading-tight truncate w-full outline-none"
              value={businesses.find((b) => b.active)?.id}
              disabled={switching}
              onChange={(e) => switchBusiness(e.target.value)}
            >
              {businesses.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          ) : (
            <p className="font-semibold text-sm leading-tight truncate">{businessName}</p>
          )}
          <p className="text-[11px] text-muted">UltraCRM{planName ? ` · ${planName}` : ""}</p>
        </div>
      </div>
      <nav className="flex-1 p-2 space-y-3 overflow-y-auto">
        {SECTIONS.map((section) => {
          const items = section.items.filter((i) => i.roles.includes(user.role as Role) && (!i.module || modules[i.module]));
          if (!items.length) return null;
          return (
            <div key={section.title}>
              <p className="px-3 pb-1 text-[10px] uppercase tracking-wider text-muted/70">{section.title}</p>
              <div className="space-y-0.5">
                {items.map((i) => {
                  const active = i.match ? i.match(pathname) : pathname === i.href || pathname.startsWith(i.href + "/");
                  return (
                    <Link key={i.href} href={i.href} className={cx("flex items-center gap-3 px-3 h-9 rounded-lg text-sm transition-colors", active ? "bg-accent text-white" : "text-muted hover:text-text hover:bg-white/5")}>
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d={i.icon} />
                      </svg>
                      {i.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>
      <div className="p-3 border-t border-line space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{user.fullName}</p>
            <p className="text-[11px] text-muted">{user.role === "owner" ? "בעלים" : user.role === "manager" ? "מנהל" : "נציג"}</p>
          </div>
          {modules.telephony && (
            <Badge tone={presenceTone} dot>
              {PRESENCE_LABEL[presence]}
            </Badge>
          )}
        </div>
        {modules.telephony && (
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted">טלפוניה</span>
            <span className={cx(phone.status === "ready" ? "text-good" : phone.status === "simulation" ? "text-warn" : phone.status === "connecting" ? "text-info" : "text-bad")}>
              {phone.status === "ready" ? "מחובר" : phone.status === "simulation" ? "הדמיה" : phone.status === "connecting" ? "מתחבר…" : phone.status === "disconnected" ? "מנותק" : phone.status === "error" ? "שגיאה" : "—"}
            </span>
          </div>
        )}
        <button onClick={logout} className="w-full h-8 rounded-md text-xs text-muted hover:text-text hover:bg-white/5">
          התנתקות
        </button>
      </div>
    </aside>
  );
}
