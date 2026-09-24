"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useDialer } from "@/components/telephony/DialerProvider";
import { Badge, cx } from "@/components/ui";
import { PRESENCE_LABEL } from "@/lib/client/format";

const items = [
  { href: "/dialer", label: "מסך חיוג", roles: ["agent", "manager", "admin"], icon: "M2 5.5A2.5 2.5 0 0 1 4.5 3h2l2 5-2.5 1.5a11 11 0 0 0 5.5 5.5L13 12.5l5 2v2A2.5 2.5 0 0 1 15.5 19 13.5 13.5 0 0 1 2 5.5z" },
  { href: "/tasks", label: "משימות חזרה", roles: ["agent", "manager", "admin"], icon: "M4 6h16M4 12h16M4 18h10" },
  { href: "/contacts", label: "אנשי קשר", roles: ["agent", "manager", "admin"], icon: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" },
  { href: "/lists", label: "רשימות חיוג", roles: ["agent", "manager", "admin"], icon: "M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2" },
  { href: "/manager", label: "מסך מנהל", roles: ["manager", "admin"], icon: "M3 3v18h18M7 14l4-4 4 4 5-6" },
  { href: "/manager/calls", label: "היסטוריית שיחות", roles: ["manager", "admin"], icon: "M12 8v4l3 3M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" },
  { href: "/settings", label: "הגדרות", roles: ["admin", "manager"], icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" },
];

export function Sidebar({ user, businessName }: { user: { fullName: string; role: string }; businessName: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const { state, phone } = useDialer();
  const presence = state?.presence ?? "offline";
  const presenceTone = presence === "in_call" ? "good" : presence === "available" ? "info" : presence === "wrap_up" ? "warn" : presence === "paused" ? "warn" : "neutral";

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  return (
    <aside className="w-[220px] shrink-0 h-screen sticky top-0 bg-panel border-s border-line flex flex-col">
      <div className="px-4 h-14 flex items-center gap-3 border-b border-line">
        <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center text-white font-bold">D</div>
        <div className="min-w-0">
          <p className="font-semibold text-sm leading-tight truncate">{businessName}</p>
          <p className="text-[11px] text-muted">מוקד שיחות</p>
        </div>
      </div>
      <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
        {items
          .filter((i) => i.roles.includes(user.role))
          .map((i) => {
            const active = pathname === i.href || (i.href !== "/manager" && pathname.startsWith(i.href + "/")) || (i.href === "/manager" && pathname === "/manager");
            return (
              <Link key={i.href} href={i.href} className={cx("flex items-center gap-3 px-3 h-10 rounded-lg text-sm transition-colors", active ? "bg-accent text-white" : "text-muted hover:text-text hover:bg-white/5")}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d={i.icon} />
                </svg>
                {i.label}
              </Link>
            );
          })}
      </nav>
      <div className="p-3 border-t border-line space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{user.fullName}</p>
            <p className="text-[11px] text-muted">{user.role === "admin" ? "מנהל מערכת" : user.role === "manager" ? "מנהל מוקד" : "נציג"}</p>
          </div>
          <Badge tone={presenceTone} dot>
            {PRESENCE_LABEL[presence]}
          </Badge>
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-muted">טלפוניה</span>
          <span className={cx(phone.status === "ready" ? "text-good" : phone.status === "simulation" ? "text-warn" : phone.status === "connecting" ? "text-info" : "text-bad")}>
            {phone.status === "ready" ? "מחובר" : phone.status === "simulation" ? "הדמיה" : phone.status === "connecting" ? "מתחבר…" : phone.status === "disconnected" ? "מנותק" : phone.status === "error" ? "שגיאה" : "—"}
          </span>
        </div>
        <button onClick={logout} className="w-full h-8 rounded-md text-xs text-muted hover:text-text hover:bg-white/5">
          התנתקות
        </button>
      </div>
    </aside>
  );
}
