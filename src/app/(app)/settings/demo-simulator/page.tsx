import { organizationRequest } from "@/lib/auth-compat";
import { auth } from "@/lib/auth-compat";
import { hasRole, ROLES_ADMIN_MANAGER } from "@/lib/auth-compat";
import { AccessDenied } from "@/components/shared/access-denied";
import { prisma } from "@/lib/db";
import { DemoSimulatorForm } from "./demo-simulator-form";

export default organizationRequest(async function DemoSimulatorPage() {
  const session = await auth();

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
      <h1 className="mb-1 text-lg font-semibold">סימולטור וואטסאפ (Demo)</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        שלח הודעה נכנסת מדומה מאיש קשר קיים כדי לבדוק את התיבה בזמן אמת.
      </p>
      <DemoSimulatorForm contacts={contacts} />
    </div>
  );
});
