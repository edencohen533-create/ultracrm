"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { useT } from "@/components/i18n/LangProvider";

type Row = { id: string; name: string; isActive: boolean; trigger: string; steps: unknown[]; _count?: { runs: number } };
const TRIGGERS: Record<string, [string, string]> = { CART_ABANDONED: ["עגלה ננטשה", "Cart abandoned"], CONTACT_CREATED: ["איש קשר חדש", "New contact"], TAG_ADDED: ["תגית נוספה", "Tag added"], LEAD_STATUS_CHANGED: ["סטטוס ליד השתנה", "Lead status changed"], DELIVERY_FAILED: ["הודעה נכשלה במסירה", "Message delivery failed"], SENT_NO_REPLY: ["נשלח ואין תשובה", "Sent, no reply"] };

/** Customer journeys ("מסע לקוח") – list + entry to the visual builder. */
export function JourneyList({ journeys }: { journeys: Row[] }) {
  const router = useRouter();
  const t = useT();
  async function remove(j: Row) {
    if (!confirm(t(`למחוק את המסע "${j.name}"? אנשי קשר שנמצאים בו ייעצרו.`, `Delete the journey "${j.name}"? Contacts currently in it will be stopped.`))) return;
    try { await api.delete(`/api/sequences/${j.id}`); toast.success(t("המסע נמחק", "Journey deleted")); router.refresh(); } catch (e) { toast.error((e as Error).message); }
  }
  return (
    <section className="jl" data-testid="journeys">
      <header><div><h2>{t("מסע לקוח", "Customer journeys")}</h2><p>{t("טריגר ← המתנות, תנאים, הודעות WhatsApp/SMS/אימייל, תגיות, רשימות, התראות ו-Webhook. הסכמה והסרה נבדקות לפני כל שליחה.", "Trigger → waits, conditions, WhatsApp/SMS/email messages, tags, lists, notifications and webhooks. Consent and unsubscribes are checked before every send.")}</p></div><Link href="/automations/journeys/new" className="cmp-btn primary" data-testid="journey-new">{t("מסע לקוח חדש", "New customer journey")}</Link></header>
      {journeys.length === 0 ? <p className="cmp-empty">{t("עדיין אין מסעות לקוח.", "No customer journeys yet.")}</p> : <div className="cmp-rows">{journeys.map((j) => (
        <article key={j.id} className="cmp-row jl-row" data-testid={`journey-row-${j.id}`}>
          <div className="cmp-row-main"><h3>{j.name}</h3><p>{TRIGGERS[j.trigger] ? t(...TRIGGERS[j.trigger]) : j.trigger} · {j.steps.length} {t("פעולות", "actions")}{j._count ? t(` · ${j._count.runs} אנשי קשר עברו`, ` · ${j._count.runs} contacts went through`) : ""}</p></div>
          <div className="cmp-row-status"><span className={`cmp-badge ${j.isActive ? "sent" : "draft"}`}>{j.isActive ? t("פעיל", "Active") : t("לא פעיל", "Inactive")}</span></div>
          <div className="cmp-row-actions"><Link href={`/automations/journeys/${j.id}`} className="cmp-btn outline">{t("עריכה", "Edit")}</Link><button className="cmp-btn" onClick={() => remove(j)}>{t("מחיקה", "Delete")}</button></div>
        </article>))}</div>}
    </section>
  );
}
