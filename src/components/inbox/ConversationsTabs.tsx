"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui";

/** "שיחות" = one area with two tabs: WhatsApp threads (/inbox) and phone calls (/calls). */
export function ConversationsTabs({ telephony }: { telephony: boolean }) {
  const pathname = usePathname();
  const tabs = [{ href: "/inbox", label: "וואטסאפ", active: pathname.startsWith("/inbox") }, ...(telephony ? [{ href: "/calls", label: "שיחות טלפון", active: pathname.startsWith("/calls") }] : [])];
  return (
    <div className="flex items-center gap-1 border-b border-line px-3 h-10 shrink-0" data-testid="conversations-tabs">
      <span className="text-sm font-semibold me-3">שיחות</span>
      {tabs.map((t) => (
        <Link key={t.href} href={t.href} className={cx("h-8 px-3 inline-flex items-center rounded-md text-sm", t.active ? "bg-accent text-white" : "text-muted hover:text-text hover:bg-white/5")}>{t.label}</Link>
      ))}
    </div>
  );
}
