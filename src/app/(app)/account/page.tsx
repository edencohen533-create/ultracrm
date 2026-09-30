import { redirect } from "next/navigation";
import { getValidSession, membershipsForAccount } from "@/lib/auth";
import { db } from "@/lib/db";
import { withoutBusiness } from "@/lib/tenant";
import { serverT } from "@/lib/i18n-server";
import { PasswordPanel } from "@/components/account/PasswordPanel";
import { LanguageToggle } from "@/components/i18n/LanguageToggle";

export const dynamic = "force-dynamic";
const ROLE: Record<string, [string, string]> = { owner: ["בעלים", "Owner"], manager: ["מנהל", "Manager"], agent: ["נציג", "Agent"] };

/**
 * "החשבון שלי" – the personal level: who you are, your sign-in password and language, and your role in EACH business.
 * Business settings stay in /settings (the active business); the platform level is a separate account flag.
 */
export default async function AccountPage() {
  const s = await getValidSession();
  if (!s) redirect("/login");
  const t = await serverT();
  const [account, memberships] = await Promise.all([
    withoutBusiness(() => db.account.findUnique({ where: { id: s.accountId }, select: { email: true, fullName: true, isPlatformAdmin: true, createdAt: true } })),
    membershipsForAccount(s.accountId),
  ]);
  return (
    <div className="p-5 space-y-4 max-w-3xl" data-testid="my-account">
      <h1 className="text-lg font-semibold">{t("החשבון שלי", "My account")}</h1>
      <section className="rounded-xl border border-line bg-panel p-4 space-y-1">
        <p className="font-medium">{account?.fullName}</p>
        <p className="text-sm text-muted" dir="ltr">{account?.email}</p>
        <p className="text-xs text-muted">{t("החשבון האישי הוא הזהות שלך לכניסה. תפקיד נקבע בנפרד בכל עסק.", "Your account is your sign-in identity. Your role is set separately in each business.")}</p>
      </section>
      <section className="rounded-xl border border-line bg-panel p-4" data-testid="my-memberships">
        <h2 className="font-semibold mb-2">{t("העסקים שלי והתפקיד בכל אחד", "My businesses and my role in each")}</h2>
        {memberships.length === 0 ? <p className="text-sm text-muted">{t("אין חברות פעילה בעסק", "No active membership")}</p> : (
          <ul className="space-y-1 text-sm">{memberships.map((m) => <li key={m.id} className="flex justify-between gap-2"><span>{m.business.name}{m.businessId === s.businessId && !s.support ? ` · ${t("פעיל עכשיו", "active now")}` : ""}</span><b>{t(...(ROLE[m.role] ?? [m.role, m.role]))} {t("בעסק זה", "in this business")}</b></li>)}</ul>
        )}
        <p className="mt-2 text-xs text-muted">{t("\"בעלים\" הוא תפקיד בתוך עסק מסוים בלבד – הוא אינו מעניק ניהול של הפלטפורמה או של עסקים אחרים.", "\"Owner\" is a role inside one business only – it grants no platform management and no other business.")}</p>
      </section>
      <section className="rounded-xl border border-line bg-panel p-4" data-testid="my-platform-role">
        <h2 className="font-semibold mb-1">{t("ניהול הפלטפורמה", "Platform administration")}</h2>
        {account?.isPlatformAdmin
          ? <p className="text-sm">{t("החשבון שלך מוגדר כמנהל פלטפורמה. ", "Your account is a platform administrator. ")}<a href="/platform" className="underline">{t("לניהול הפלטפורמה", "Go to platform administration")}</a></p>
          : <p className="text-sm text-muted">{t("החשבון שלך אינו מנהל פלטפורמה. ההרשאה מוענקת רק בתהליך הקמה מאובטח בצד השרת, ואינה ניתנת להגדרה מתוך העסק.", "Your account is not a platform administrator. It is granted only by a secure server-side setup and cannot be set from a business.")}</p>}
      </section>
      <PasswordPanel />
      <section className="rounded-xl border border-line bg-panel p-4 flex items-center justify-between"><span className="text-sm">{t("שפת ממשק", "Interface language")}</span><LanguageToggle className="h-9 px-3 rounded-md border border-line" /></section>
    </div>
  );
}
