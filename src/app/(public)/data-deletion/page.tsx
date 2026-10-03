import Link from "next/link";
import type { Metadata } from "next";
import { serverT } from "@/lib/i18n-server";
import { platformIdentity } from "@/lib/platform-identity";
import { deletionStatus } from "@/server/services/meta-deletion-service";
import { PublicShell, Doc } from "@/components/public/PublicShell";

export const metadata: Metadata = { title: "Data Deletion – Solina CRM" };
export const dynamic = "force-dynamic";

/** Data deletion instructions (Meta "Data Deletion Instructions URL") + status lookup for a confirmation code. */
export default async function DataDeletionPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const t = await serverT();
  const id = platformIdentity();
  const { code } = await searchParams;
  const status = code ? await deletionStatus(code).catch(() => null) : null;
  const label: Record<string, [string, string]> = { completed: ["הושלם – החיבור נותק והאסימונים ונתוני Meta נמחקו", "Completed – the connection was removed and the tokens and Meta identifiers were deleted"], no_data: ["הושלם – לא נמצאו אצלנו נתונים שקשורים למשתמש הזה", "Completed – we hold no data linked to this user"], received: ["התקבל – בטיפול", "Received – in progress"] };
  return (
    <PublicShell>
      <Doc title={t("מחיקת נתונים", "Data Deletion")}>
        {code && (
          <div className="rounded-lg border border-line bg-panel p-4" data-testid="deletion-status">
            <b>{t("סטטוס בקשה", "Request status")} {code}: </b>
            {status ? <>{t(...label[status.status] ?? [status.status, status.status])} · {new Date(status.completedAt ?? status.createdAt).toISOString().slice(0, 10)}</> : t("לא נמצאה בקשה עם הקוד הזה", "No request found for this code")}
          </div>
        )}
        <p>{t(`אפשר למחוק את הנתונים שלך מ-${id.product} בכל אחת מהדרכים הבאות:`, `You can delete your data from ${id.product} in any of these ways:`)}</p>
        <h2>{t("1. מתוך המערכת (מיידי)", "1. In the product (immediate)")}</h2>
        <ul>
          <li>{t("בעל העסק: הגדרות → חשבון → \"מחיקת העסק וכל הנתונים\". החיבור ל-WhatsApp מנותק והאסימונים נמחקים מיד; כל שאר הנתונים (אנשי קשר, הודעות, שיחות, משתמשים) נמחקים לצמיתות אחרי 14 יום, ואפשר לבטל עד אז.", "Business owner: Settings → Account → \"Delete business and all data\". The WhatsApp connection is disconnected and tokens are erased immediately; all other data (contacts, messages, calls, users) is permanently deleted after 14 days, cancellable until then.")}</li>
          <li>{t("כל משתמש: הגדרות → חשבון → \"מחיקת המשתמש שלי\" – השם, האימייל והטלפון נמחקים מיד.", "Any user: Settings → Account → \"Delete my user\" – your name, email and phone are erased immediately.")}</li>
          <li>{t("ניתוק WhatsApp בלבד: הגדרות → WhatsApp → \"נתק\".", "Disconnect WhatsApp only: Settings → WhatsApp → \"Disconnect\".")}</li>
        </ul>
        <h2>{t("2. דרך פייסבוק", "2. Through Facebook")}</h2>
        <p>{t(`בפייסבוק: הגדרות ופרטיות → הגדרות → אינטגרציות עסקיות (Business Integrations) → בחר/י את ${id.product} → הסר. להסרת נתונים, פתח/י את פרטי האפליקציה שהוסרה ולחץ/י Send Request (בקשת מחיקה). Meta תשלח לנו בקשת מחיקה, החיבור ל-WhatsApp ינותק והאסימונים ונתוני Meta יימחקו. תקבל/י קוד אישור שאפשר לבדוק בעמוד הזה למשך 90 יום.`, `On Facebook: Settings & privacy → Settings → Business Integrations → select ${id.product} → Remove. To delete data, open the removed app details and select Send Request. Meta sends us a deletion request; the WhatsApp connection is removed and the tokens and Meta identifiers are deleted. You receive a confirmation code you can check on this page for 90 days.`)}</p>
        <h2>{t("3. בפנייה אלינו", "3. By contacting us")}</h2>
        <p>{id.privacyEmail ? <>{t("שלח/י בקשה ל-", "Email ")}<a href={`mailto:${id.privacyEmail}`}>{id.privacyEmail}</a>{t(" מהאימייל של החשבון. נטפל תוך 30 יום.", " from your account email. We handle it within 30 days.")}</> : <>{t("דרך ", "Through the ")}<Link href="/support">{t("טופס התמיכה", "support form")}</Link>{t(" – נטפל תוך 30 יום.", " – we handle it within 30 days.")}</>}</p>
        <h2>{t("לקוחות של עסק שמשתמש במערכת", "Customers of a business that uses the product")}</h2>
        <p>{t("אם עסק שלח לך הודעות דרך המערכת, פנה/י לעסק עצמו (הוא האחראי על הנתונים שלך). אפשר גם להשיב \"הסר\" או STOP בוואטסאפ כדי להפסיק הודעות שיווקיות.", "If a business messaged you through the product, contact that business (it controls your data). You can also reply \"STOP\" on WhatsApp to stop marketing messages.")}</p>
        <form className="rounded-lg border border-line bg-panel p-4 flex flex-wrap gap-2 items-end" action="/data-deletion">
          <label className="text-sm">{t("בדיקת סטטוס לפי קוד אישור", "Check status by confirmation code")}<input name="code" defaultValue={code ?? ""} className="block mt-1 h-9 rounded-md border border-line bg-bg px-2 ltr" /></label>
          <button className="rounded-md bg-accent text-white px-3 h-9 text-sm">{t("בדוק", "Check")}</button>
        </form>
      </Doc>
    </PublicShell>
  );
}
