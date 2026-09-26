"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { EmptyState, Spinner } from "@/components/ui";
import { formatDateTime, formatDuration } from "@/lib/client/format";
import type { TimelineItem } from "@/lib/crm/timeline";

const KIND_ICON: Record<TimelineItem["kind"], string> = { call: "📞", message: "💬", note: "📝", task: "✅", lead: "⭐", deal: "💼", event: "⚡" };
const KIND_LABEL: Record<TimelineItem["kind"], string> = { call: "שיחה", message: "הודעה", note: "הערה", task: "משימה", lead: "ליד", deal: "עסקה", event: "אירוע" };

/** One activity timeline for the contact: calls + outcomes, messages, notes, status changes, tasks, deals, automations. */
export function ContactTimeline({ contactId, refreshKey = 0, limit }: { contactId: string; refreshKey?: number; limit?: number }) {
  const [items, setItems] = useState<TimelineItem[] | null>(null);
  useEffect(() => {
    let alive = true;
    api.get<{ items: TimelineItem[] }>(`/api/contacts/${contactId}/timeline`).then((r) => alive && setItems(limit ? r.items.slice(0, limit) : r.items)).catch(() => alive && setItems([]));
    return () => { alive = false; };
  }, [contactId, refreshKey, limit]);
  if (!items) return <div className="p-4"><Spinner /></div>;
  if (items.length === 0) return <EmptyState title="אין פעילות עדיין" />;
  return (
    <ul className="divide-y divide-line" data-testid="contact-timeline">
      {items.map((it) => (
        <li key={it.id} className="px-4 py-2 flex gap-3 text-sm">
          <span className="shrink-0 w-6 text-center" aria-hidden title={KIND_LABEL[it.kind]}>{KIND_ICON[it.kind]}</span>
          <div className="min-w-0 flex-1">
            <p className="font-medium"><span className="text-[10px] uppercase text-muted me-2">{KIND_LABEL[it.kind]}</span>{it.href ? <Link href={it.href} className="hover:underline">{it.title}</Link> : it.title}</p>
            {it.body && <p className="text-xs text-muted whitespace-pre-wrap">{it.body}</p>}
            {it.kind === "call" && it.meta?.recording ? <audio controls preload="none" src={String(it.meta.recording)} className="h-7 w-56 mt-1" /> : null}
            {it.kind === "call" && typeof it.meta?.talkSeconds === "number" && it.meta.talkSeconds > 0 ? <p className="text-[11px] text-muted">משך: {formatDuration(it.meta.talkSeconds as number)}</p> : null}
          </div>
          <div className="text-xs text-muted text-end shrink-0 tabular"><p>{formatDateTime(it.at)}</p>{it.actor && <p>{it.actor}</p>}</div>
        </li>
      ))}
    </ul>
  );
}
