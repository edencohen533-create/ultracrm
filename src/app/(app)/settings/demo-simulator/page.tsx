import { organizationRequest } from "@/lib/auth-compat";
import { auth } from "@/lib/auth-compat";
import { hasRole, ROLES_ADMIN_MANAGER } from "@/lib/auth-compat";
import { AccessDenied } from "@/components/shared/access-denied";
import { prisma } from "@/lib/db";
import { DemoSimulatorForm } from "./demo-simulator-form";
import { serverT } from "@/lib/i18n-server";

export default organizationRequest(async function DemoSimulatorPage() {
  const session = await auth();
  const t = await serverT();

  if (!hasRole(session, ROLES_ADMIN_MANAGER)) {
    return <AccessDenied />;
  }

  const contacts = await prisma.contact.findMany({
    select: { id: true, fullName: true, phoneE164: true },
    orderBy: { fullName: "asc" },
    take: 200,
  }).then((rows) => rows.map((c) => ({ id: c.id, name: c.fullName, phone: c.phoneE164 })));

  return (
    <div className="p-6">
      <h1 className="mb-1 text-lg font-semibold">{t("סימולטור וואטסאפ (Demo)", "WhatsApp Simulator (Demo)")}</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        {t("שלח הודעה נכנסת מדומה מאיש קשר קיים כדי לבדוק את התיבה בזמן אמת.", "Send a simulated inbound message from an existing contact to test the inbox in real time.")}
      </p>
      <DemoSimulatorForm contacts={contacts} />
    </div>
  );
}, "whatsapp");
