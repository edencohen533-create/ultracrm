import Link from "next/link";
import type { Metadata } from "next";
import { serverT } from "@/lib/i18n-server";
import { platformIdentity } from "@/lib/platform-identity";
import { PublicShell, Doc } from "@/components/public/PublicShell";

export const metadata: Metadata = { title: "Terms of Service – UltraCRM" };

export default async function TermsPage() {
  const t = await serverT();
  const id = platformIdentity();
  const operator = id.legalName ?? id.product;
  return (
    <PublicShell>
      <Doc title={t("תנאי שימוש", "Terms of Service")} updated={t(`עודכן לאחרונה: ${id.updated}`, `Last updated: ${id.updated}`)}>
        <p>{t(`התנאים חלים על השימוש ב-${id.product}, המופעל על ידי ${operator}. שימוש בשירות מהווה הסכמה לתנאים ול`, `These terms govern the use of ${id.product}, operated by ${operator}. Using the service means you accept these terms and the `)}<Link href="/privacy">{t("מדיניות הפרטיות", "Privacy Policy")}</Link>.</p>
        <h2>{t("1. השירות", "1. The service")}</h2>
        <p>{t("מערכת CRM לעסקים: ניהול לידים ועסקאות, חייגן, תיבת הודעות WhatsApp, קמפיינים ב-WhatsApp, SMS ואימייל, אוטומציות ודוחות.", "A business CRM: leads and deals, a dialer, a WhatsApp inbox, WhatsApp/SMS/email campaigns, automations and reports.")}</p>
        <h2>{t("2. חשבונות", "2. Accounts")}</h2>
        <p>{t("בעל העסק אחראי למשתמשים שהוא מוסיף, להרשאות שלהם ולשמירה על סודיות פרטי הכניסה.", "The business owner is responsible for the users it adds, their permissions and keeping sign-in details confidential.")}</p>
        <h2>{t("3. שימוש ב-WhatsApp", "3. Using WhatsApp")}</h2>
        <ul>
          <li>{t("העסק מתחייב לעמוד ב-WhatsApp Business Messaging Policy, ב-WhatsApp Commerce Policy ובתנאי Meta.", "The business must comply with the WhatsApp Business Messaging Policy, the WhatsApp Commerce Policy and Meta's terms.")}</li>
          <li>{t("שליחת הודעות רק לאנשים שנתנו הסכמה (opt-in), כיבוד בקשות הסרה, ושימוש בתבניות מאושרות מחוץ לחלון 24 השעות.", "Message only people who opted in, honour opt-out requests, and use approved templates outside the 24-hour window.")}</li>
          <li>{t("העסק משלם ל-Meta ישירות על שיחות/הודעות לפי המחירון שלה, דרך אמצעי התשלום בחשבון ה-WhatsApp Business שלו.", "The business pays Meta directly for conversations/messages under Meta's pricing, through the payment method on its WhatsApp Business account.")}</li>
        </ul>
        <h2>{t("4. שימוש אסור", "4. Prohibited use")}</h2>
        <p>{t("ספאם, הודעות ללא הסכמה, תוכן לא חוקי או מטעה, התחזות, ניסיון לעקוף מגבלות או אבטחה, ושימוש שמפר זכויות של אחרים.", "Spam, unsolicited messages, illegal or misleading content, impersonation, attempts to bypass limits or security, and use that infringes others' rights.")}</p>
        <h2>{t("5. נתונים", "5. Data")}</h2>
        <p>{t("הנתונים שהעסק מכניס שייכים לו. אנחנו מעבדים אותם כדי לספק את השירות, כמתואר במדיניות הפרטיות. אפשר למחוק את העסק ואת כל הנתונים בכל עת (הגדרות → חשבון).", "Data the business enters belongs to it. We process it to provide the service, as described in the Privacy Policy. The business can delete itself and all data at any time (Settings → Account).")}</p>
        <h2>{t("6. זמינות ואחריות", "6. Availability and liability")}</h2>
        <p>{t("השירות ניתן כפי שהוא (AS IS). נפעל לזמינות גבוהה אך איננו אחראים לתקלות אצל ספקים חיצוניים (Meta, ספקי טלפוניה ודואר). האחריות שלנו מוגבלת לסכום ששולם לנו ב-12 החודשים האחרונים, ככל שהחוק מתיר.", "The service is provided AS IS. We aim for high availability but are not responsible for outages at third parties (Meta, telephony and email providers). Our liability is limited to the amount paid to us in the last 12 months, to the extent the law allows.")}</p>
        <h2>{t("7. סיום", "7. Termination")}</h2>
        <p>{t("אפשר להפסיק להשתמש בכל עת. נוכל להשעות חשבון שמפר את התנאים או את מדיניות Meta.", "You may stop using the service at any time. We may suspend an account that violates these terms or Meta's policies.")}</p>
        <h2>{t("8. דין ויצירת קשר", "8. Law and contact")}</h2>
        <p>{t("הדין הישראלי חל; סמכות השיפוט לבתי המשפט בתל אביב. פניות: ", "Israeli law applies; courts in Tel Aviv have jurisdiction. Contact: ")}<Link href="/support">{t("תמיכה", "Support")}</Link>.</p>
      </Doc>
    </PublicShell>
  );
}
