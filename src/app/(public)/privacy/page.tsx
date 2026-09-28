import Link from "next/link";
import type { Metadata } from "next";
import { serverT } from "@/lib/i18n-server";
import { platformIdentity } from "@/lib/platform-identity";
import { PublicShell, Doc } from "@/components/public/PublicShell";

export const metadata: Metadata = { title: "Privacy Policy – UltraCRM" };

/** Public privacy policy (the URL set in the Meta App Dashboard). Bilingual; the deletion section matches /data-deletion. */
export default async function PrivacyPage() {
  const t = await serverT();
  const id = platformIdentity();
  const operator = id.legalName ?? id.product;
  const contact = id.privacyEmail ? <a href={`mailto:${id.privacyEmail}`}>{id.privacyEmail}</a> : <Link href="/support">{t("טופס הפנייה", "the contact form")}</Link>;
  return (
    <PublicShell>
      <Doc title={t("מדיניות פרטיות", "Privacy Policy")} updated={t(`עודכן לאחרונה: ${id.updated}`, `Last updated: ${id.updated}`)}>
        <p>{t(`${operator} ("אנחנו") מפעילה את ${id.product} – מערכת CRM לעסקים הכוללת ניהול לידים, חייגן, ושליחה וקבלה של הודעות WhatsApp, SMS ואימייל. מדיניות זו מסבירה אילו נתונים אנחנו מעבדים, למה, עם מי הם משותפים, כמה זמן הם נשמרים ואיך מוחקים אותם.`, `${operator} ("we", "us") operates ${id.product} – a business CRM with lead management, a dialer, and sending and receiving WhatsApp, SMS and email messages. This policy explains what data we process, why, who we share it with, how long we keep it and how to delete it.`)}</p>
        {id.address && <p>{t("כתובת: ", "Address: ")}{id.address}</p>}

        <h2>{t("1. תפקידים", "1. Roles")}</h2>
        <p>{t("העסקים שמשתמשים במערכת (\"הלקוחות העסקיים\") קובעים אילו נתונים של הלקוחות שלהם נשמרים ולמה – הם בעלי השליטה בנתונים. אנחנו מעבדים את הנתונים האלה עבורם ולפי הוראותיהם בלבד. לגבי נתוני החשבון של המשתמשים במערכת עצמה (שם, אימייל, טלפון) – אנחנו בעלי השליטה.", "Businesses that use the service (\"Business Customers\") decide which data about their own customers is stored and why – they are the controllers of that data. We process it on their behalf and only on their instructions. For the account data of the people who use the service itself (name, email, phone) we are the controller.")}</p>

        <h2>{t("2. אילו נתונים אנחנו מעבדים", "2. Data we process")}</h2>
        <ul>
          <li>{t("נתוני חשבון: שם, אימייל, טלפון, תפקיד והרשאות, וסיסמה מוצפנת (hash).", "Account data: name, email, phone, role and permissions, and a hashed password.")}</li>
          <li>{t("נתוני אנשי קשר ולידים שהעסק מכניס או שנוצרים מפניות: שם, טלפון, אימייל, מקור, סטטוס, הערות, משימות ועסקאות.", "Contacts and leads the business adds or that come from inquiries: name, phone, email, source, status, notes, tasks and deals.")}</li>
          <li>{t("תקשורת: תוכן ומטא-דאטה של הודעות WhatsApp, SMS ואימייל שנשלחו והתקבלו, ופרטי שיחות טלפון (מועד, משך, תוצאה, והקלטה – רק אם העסק הפעיל הקלטה).", "Communications: content and metadata of WhatsApp, SMS and email messages sent and received, and phone-call details (time, duration, outcome, and a recording – only if the business enabled recording).")}</li>
          <li>{t("הסכמות והסרות: סטטוס הסכמה לדיוור ובקשות הסרה, כדי לכבד אותן בכל הערוצים.", "Consent and opt-outs: marketing consent status and unsubscribe requests, so they are honoured on every channel.")}</li>
          <li>{t("נתונים טכניים: לוגים של גישה ואבטחה, יומן פעולות (audit) וכתובת IP בעת כניסה.", "Technical data: access and security logs, an audit trail of actions, and the IP address at sign-in.")}</li>
        </ul>

        <h2>{t("3. נתונים מ-Meta ו-WhatsApp Business Platform", "3. Data from Meta and the WhatsApp Business Platform")}</h2>
        <p>{t("כשעסק מחבר את WhatsApp דרך תהליך ההרשמה של Meta (Embedded Signup), אנחנו מקבלים ושומרים:", "When a business connects WhatsApp through Meta's Embedded Signup, we receive and store:")}</p>
        <ul>
          <li>{t("מזהי חשבון WhatsApp Business (WABA) ומספר הטלפון העסקי, שם התצוגה, דירוג איכות ומגבלת ההודעות.", "The WhatsApp Business Account (WABA) and business phone-number identifiers, display name, quality rating and messaging limit.")}</li>
          <li>{t("אסימון גישה עסקי (business token) – מוצפן במנוחה (AES-256-GCM) ומשמש רק לפעולות שהעסק ביקש.", "A business access token – encrypted at rest (AES-256-GCM) and used only for actions the business requested.")}</li>
          <li>{t("תבניות הודעה שהעסק יצר, והסטטוס שלהן אצל Meta.", "Message templates the business created and their approval status at Meta.")}</li>
          <li>{t("הודעות נכנסות ויוצאות, סטטוסי מסירה/קריאה ועדכוני חשבון שמגיעים מ-Meta ב-webhook.", "Inbound and outbound messages, delivery/read statuses and account updates that Meta sends to our webhook.")}</li>
        </ul>
        <p>{t("השימוש בנתונים האלה הוא אך ורק כדי לאפשר לעסק לשלוח ולקבל הודעות, לנהל תבניות ומספרי טלפון, ולהציג לו את השיחות – כלומר ההרשאות whatsapp_business_messaging ו-whatsapp_business_management. אנחנו לא מוכרים נתונים שהתקבלו מ-Meta, לא משתמשים בהם לפרסום או לפרופיילינג, ולא מעבירים אותם לצד שלישי מלבד נותני השירות שבסעיף 5 לצורך הפעלת השירות.", "We use this data only to let the business send and receive messages, manage its templates and phone numbers, and show its conversations – that is, the whatsapp_business_messaging and whatsapp_business_management permissions. We do not sell data obtained from Meta, do not use it for advertising or profiling, and do not transfer it to third parties other than the service providers in section 5 for operating the service.")}</p>

        <h2>{t("4. למה אנחנו משתמשים בנתונים", "4. How we use data")}</h2>
        <ul>
          <li>{t("לספק את השירות: ניהול לידים, חיוג, שליחה וקבלה של הודעות, דוחות ואוטומציות שהעסק הגדיר.", "To provide the service: lead management, dialing, sending and receiving messages, reports and automations the business configured.")}</li>
          <li>{t("אבטחה, מניעת שימוש לרעה ואכיפת הסכמות והסרות.", "Security, abuse prevention and enforcing consent and opt-outs.")}</li>
          <li>{t("תמיכה ותפעול. תכונות AI (אם העסק הפעיל אותן) מעבדות רק נתונים שהמשתמש רשאי לראות, ולא משמשות לאימון מודלים.", "Support and operations. AI features (if the business enabled them) process only data the user may see and are not used to train models.")}</li>
        </ul>

        <h2>{t("5. שיתוף עם נותני שירות", "5. Sharing with service providers")}</h2>
        <ul>
          <li>{t("Meta Platforms (WhatsApp Business Platform / Cloud API) – שליחה וקבלה של הודעות WhatsApp.", "Meta Platforms (WhatsApp Business Platform / Cloud API) – sending and receiving WhatsApp messages.")}</li>
          <li>{t("Telnyx – שיחות טלפון ו-SMS. Resend – אימייל.", "Telnyx – phone calls and SMS. Resend – email.")}</li>
          <li>{t("Vercel – אירוח. Neon – מסד נתונים (PostgreSQL). Anthropic – תכונות AI, רק אם הופעלו.", "Vercel – hosting. Neon – database (PostgreSQL). Anthropic – AI features, only if enabled.")}</li>
        </ul>
        <p>{t("נמסור נתונים לרשויות רק כשהחוק מחייב זאת.", "We disclose data to authorities only when required by law.")}</p>

        <h2>{t("6. שמירה", "6. Retention")}</h2>
        <p>{t("הנתונים נשמרים כל עוד החשבון העסקי פעיל. העסק יכול להגדיר תקופת שמירה קצרה יותר להודעות וליומנים. לאחר בקשת מחיקה – הנתונים נמחקים תוך 30 יום (ראו סעיף 8). גיבויים נמחקים במחזור הרגיל שלהם.", "Data is kept while the business account is active. The business can set shorter retention for messages and logs. After a deletion request, data is deleted within 30 days (see section 8). Backups are purged in their normal cycle.")}</p>

        <h2>{t("7. אבטחה", "7. Security")}</h2>
        <p>{t("תעבורה מוצפנת (TLS), הצפנת אסימונים וסודות במנוחה, הפרדה בין עסקים ברמת מסד הנתונים (Row-Level Security), הרשאות לפי תפקיד, ויומן פעולות.", "Encrypted transport (TLS), tokens and secrets encrypted at rest, database-level isolation between businesses (Row-Level Security), role-based permissions and an audit trail.")}</p>

        <h2 id="deletion">{t("8. מחיקת נתונים", "8. Data deletion")}</h2>
        <ul>
          <li>{t("בעל העסק: הגדרות → חשבון → \"מחיקת העסק וכל הנתונים\". החיבור ל-WhatsApp מנותק והאסימונים נמחקים מיד; שאר הנתונים נמחקים לצמיתות אחרי 14 יום (אפשר לבטל עד אז).", "Business owner: Settings → Account → \"Delete business and all data\". The WhatsApp connection is disconnected and tokens are erased immediately; everything else is permanently deleted after 14 days (cancellable until then).")}</li>
          <li>{t("כל משתמש: הגדרות → חשבון → \"מחיקת המשתמש שלי\" – הפרטים האישיים נמחקים, ורשומות העסק נשארות ללא זיהוי.", "Any user: Settings → Account → \"Delete my user\" – personal details are erased; the business's records remain without identifying you.")}</li>
          <li>{t("הסרת האפליקציה מהגדרות פייסבוק (אינטגרציות עסקיות) שולחת לנו בקשת מחיקה אוטומטית ומנתקת את חיבור ה-WhatsApp.", "Removing the app in your Facebook settings (Business Integrations) sends us an automatic deletion request and disconnects WhatsApp.")}</li>
          <li>{t("לקוחות של עסק שמשתמש במערכת פונים לעסק עצמו; אנחנו נסייע לו לבצע את הבקשה.", "Customers of a business that uses the service should contact that business; we help it fulfil the request.")}</li>
        </ul>
        <p>{t("פרטים ובדיקת סטטוס בקשה: ", "Details and request status: ")}<Link href="/data-deletion">{t("מחיקת נתונים", "Data Deletion")}</Link>.</p>

        <h2>{t("9. הזכויות שלך", "9. Your rights")}</h2>
        <p>{t("אפשר לבקש עיון, תיקון, מחיקה או הגבלת עיבוד של הנתונים שלך. פנייה: ", "You may request access to, correction, deletion or restriction of your data. Contact: ")}{contact}.</p>

        <h2>{t("10. קטינים", "10. Children")}</h2>
        <p>{t("השירות מיועד לעסקים ואינו מיועד לילדים מתחת לגיל 16.", "The service is for businesses and is not directed to children under 16.")}</p>

        <h2>{t("11. שינויים ויצירת קשר", "11. Changes and contact")}</h2>
        <p>{t("נעדכן כאן כל שינוי במדיניות. שאלות: ", "Any change to this policy will be published here. Questions: ")}{contact}.</p>
      </Doc>
    </PublicShell>
  );
}
