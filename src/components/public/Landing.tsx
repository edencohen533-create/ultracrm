import Link from "next/link";
import { MessageCircle, PhoneCall, Users, Megaphone, ShieldCheck, Workflow } from "lucide-react";
import { serverT } from "@/lib/i18n-server";
import { platformIdentity } from "@/lib/platform-identity";
import { PublicShell } from "./PublicShell";

/** Public home page for logged-out visitors: what the product is and how WhatsApp is used. */
export async function Landing() {
  const t = await serverT();
  const id = platformIdentity();
  const features: Array<[React.ReactNode, string, string]> = [
    [<MessageCircle key="w" size={20} />, t("תיבת WhatsApp לצוות", "Team WhatsApp inbox"), t("העסק מחבר את מספר ה-WhatsApp Business שלו דרך Meta, והצוות עונה ללקוחות מתיבה משותפת – עם שיוך שיחות, הערות וחלון 24 השעות.", "Businesses connect their own WhatsApp Business number through Meta and the team answers customers from a shared inbox – with assignment, notes and the 24-hour window.")],
    [<Workflow key="t" size={20} />, t("תבניות הודעה", "Message templates"), t("יצירת תבניות WhatsApp, הגשה לאישור Meta ומעקב אחרי הסטטוס – לשליחה מחוץ לחלון השירות.", "Create WhatsApp templates, submit them for Meta approval and track their status – for messages outside the service window.")],
    [<Users key="c" size={20} />, t("CRM ולידים", "CRM and leads"), t("ניהול לידים, פולואפים, עסקאות ומשימות, עם חלוקה אוטומטית לנציגים.", "Leads, follow-ups, deals and tasks, with automatic distribution to agents.")],
    [<PhoneCall key="d" size={20} />, t("חייגן", "Dialer"), t("חייגן Power/Preview עם תיעוד שיחות, הקלטות וסטטיסטיקות.", "Power/preview dialer with call notes, recordings and statistics.")],
    [<Megaphone key="m" size={20} />, t("קמפיינים", "Campaigns"), t("הודעות תפוצה ב-WhatsApp, SMS ואימייל – רק לנמענים שהסכימו, עם הסרה בכל הערוצים.", "WhatsApp, SMS and email broadcasts – only to recipients who opted in, with opt-out across channels.")],
    [<ShieldCheck key="s" size={20} />, t("פרטיות ואבטחה", "Privacy and security"), t("הפרדה מלאה בין עסקים, הצפנת אסימונים, הרשאות לפי תפקיד ומחיקת נתונים בכל עת.", "Full isolation between businesses, encrypted tokens, role-based permissions and data deletion at any time.")],
  ];
  return (
    <PublicShell>
      <section className="max-w-5xl mx-auto px-4 py-16 text-center space-y-5" data-testid="landing">
        <h1 className="text-3xl md:text-4xl font-bold">{t(`${id.product} – CRM, WhatsApp וחייגן במקום אחד`, `${id.product} – CRM, WhatsApp and a dialer in one place`)}</h1>
        <p className="text-muted max-w-2xl mx-auto">{t("פלטפורמה לצוותי מכירות ושירות: לידים, שיחות, הודעות WhatsApp Business, SMS ואימייל – עם אוטומציות ודוחות. כל עסק מחבר את חשבון ה-WhatsApp Business שלו ושולח הודעות רק ללקוחות שהסכימו.", "A platform for sales and support teams: leads, calls, WhatsApp Business messages, SMS and email – with automations and reports. Each business connects its own WhatsApp Business account and messages only customers who opted in.")}</p>
        <div className="flex justify-center gap-3"><Link href="/login" className="rounded-md bg-accent text-white px-5 h-11 inline-flex items-center font-medium">{t("כניסה למערכת", "Log in")}</Link><Link href="/support" className="rounded-md border border-line px-5 h-11 inline-flex items-center">{t("יצירת קשר", "Contact us")}</Link></div>
      </section>
      <section className="max-w-5xl mx-auto px-4 pb-16 grid md:grid-cols-3 gap-4">
        {features.map(([icon, title, text]) => <div key={title} className="rounded-xl border border-line bg-panel p-5 space-y-2"><div className="text-accent">{icon}</div><h2 className="font-semibold">{title}</h2><p className="text-sm text-muted">{text}</p></div>)}
      </section>
      <section className="max-w-3xl mx-auto px-4 pb-16 text-sm text-muted space-y-2">
        <h2 className="text-base font-semibold text-text">{t("איך WhatsApp עובד במערכת", "How WhatsApp works in the product")}</h2>
        <p>{t("בעל העסק לוחץ \"חבר WhatsApp\" ומשלים את תהליך ההרשמה של Meta (Embedded Signup) – בוחר את החשבון העסקי ואת המספר. מאותו רגע ההודעות שנשלחות ומתקבלות במספר הזה מופיעות בתיבת ההודעות, ותבניות שנוצרות במערכת מוגשות לאישור Meta. החיבור ניתן לניתוק בכל עת, והנתונים ניתנים למחיקה.", "The business owner clicks \"Connect WhatsApp\" and completes Meta's Embedded Signup – choosing the business account and phone number. From then on, messages sent to and from that number appear in the inbox, and templates created in the product are submitted for Meta's approval. The connection can be removed at any time and the data can be deleted.")}</p>
        <p><Link href="/privacy" className="underline">{t("מדיניות פרטיות", "Privacy Policy")}</Link> · <Link href="/terms" className="underline">{t("תנאי שימוש", "Terms of Service")}</Link> · <Link href="/data-deletion" className="underline">{t("מחיקת נתונים", "Data Deletion")}</Link></p>
      </section>
    </PublicShell>
  );
}
