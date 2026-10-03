import type { Metadata } from "next";
import { serverT } from "@/lib/i18n-server";
import { platformIdentity } from "@/lib/platform-identity";
import { PublicShell, Doc } from "@/components/public/PublicShell";
import { SupportForm } from "@/components/public/SupportForm";

export const metadata: Metadata = { title: "Support – Solina CRM" };

export default async function SupportPage() {
  const t = await serverT();
  const id = platformIdentity();
  return (
    <PublicShell>
      <Doc title={t("תמיכה ויצירת קשר", "Support and contact")}>
        <p>{t("שאלות, תקלות, פרטיות או מחיקת נתונים – השאירו פרטים ונחזור אליכם באימייל, בדרך כלל תוך יום עסקים.", "Questions, issues, privacy or data deletion – leave your details and we will reply by email, usually within one business day.")}</p>
        {id.supportEmail && <p>{t("אימייל: ", "Email: ")}<a href={`mailto:${id.supportEmail}`}>{id.supportEmail}</a></p>}
        {id.legalName && <p>{id.legalName}{id.address ? ` · ${id.address}` : ""}</p>}
        <SupportForm />
      </Doc>
    </PublicShell>
  );
}
