"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/client/api";

type Row = { id: string; name: string; isActive: boolean; trigger: string; steps: unknown[]; _count?: { runs: number } };
const TRIGGERS: Record<string, string> = { CART_ABANDONED: "עגלה ננטשה", CONTACT_CREATED: "איש קשר חדש", TAG_ADDED: "תגית נוספה", LEAD_STATUS_CHANGED: "סטטוס ליד השתנה", DELIVERY_FAILED: "הודעה נכשלה במסירה", SENT_NO_REPLY: "נשלח ואין תשובה" };

/** Customer journeys ("מסע לקוח") – list + entry to the visual builder. */
export function JourneyList({ journeys }: { journeys: Row[] }) {
  const router = useRouter();
  async function remove(j: Row) {
    if (!confirm(`למחוק את המסע "${j.name}"? אנשי קשר שנמצאים בו ייעצרו.`)) return;
    try { await api.delete(`/api/sequences/${j.id}`); toast.success("המסע נמחק"); router.refresh(); } catch (e) { toast.error((e as Error).message); }
  }
  return (
    <section className="jl" data-testid="journeys">
      <header><div><h2>מסע לקוח</h2><p>טריגר ← המתנות, תנאים, הודעות WhatsApp/SMS/אימייל, תגיות, רשימות, התראות ו-Webhook. הסכמה והסרה נבדקות לפני כל שליחה.</p></div><Link href="/automations/journeys/new" className="cmp-btn primary" data-testid="journey-new">מסע לקוח חדש</Link></header>
      {journeys.length === 0 ? <p className="cmp-empty">עדיין אין מסעות לקוח.</p> : <div className="cmp-rows">{journeys.map((j) => (
        <article key={j.id} className="cmp-row jl-row" data-testid={`journey-row-${j.id}`}>
          <div className="cmp-row-main"><h3>{j.name}</h3><p>{TRIGGERS[j.trigger] ?? j.trigger} · {j.steps.length} פעולות{j._count ? ` · ${j._count.runs} אנשי קשר עברו` : ""}</p></div>
          <div className="cmp-row-status"><span className={`cmp-badge ${j.isActive ? "sent" : "draft"}`}>{j.isActive ? "פעיל" : "לא פעיל"}</span></div>
          <div className="cmp-row-actions"><Link href={`/automations/journeys/${j.id}`} className="cmp-btn outline">עריכה</Link><button className="cmp-btn" onClick={() => remove(j)}>מחיקה</button></div>
        </article>))}</div>}
    </section>
  );
}
