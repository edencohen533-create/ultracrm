import type { Metadata } from "next";
import { serverT } from "@/lib/i18n-server";
import { PublicShell, Doc } from "@/components/public/PublicShell";
import { InviteAccept } from "@/components/public/InviteAccept";
import { inviteInfo } from "@/server/services/invite-service";

export const metadata: Metadata = { title: "Invitation – UltraCRM", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const t = await serverT();
  const { token } = await params;
  const info = await inviteInfo(token).catch(() => null);
  return (
    <PublicShell>
      <Doc title={t("הצטרפות לעסק", "Join a business")}>
        {info ? <InviteAccept token={token} businessName={info.businessName} email={info.email} mode={info.mode} />
          : <p>{t("ההזמנה אינה בתוקף או שכבר נוצלה. בקש מבעל העסק קישור חדש.", "This invitation is no longer valid or was already used. Ask the business owner for a new link.")}</p>}
      </Doc>
    </PublicShell>
  );
}
