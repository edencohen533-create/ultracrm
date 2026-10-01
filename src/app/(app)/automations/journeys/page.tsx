import { organizationRequest, auth, hasRole, ROLES_ADMIN_MANAGER } from "@/lib/auth-compat";
import { AccessDenied } from "@/components/shared/access-denied";
import { AutomationsTabs } from "@/components/automations/AutomationsTabs";
import { JourneyList } from "@/components/automations/journey/journey-list";
import { listSequences } from "@/server/services/sequence-service";
import { serverT } from "@/lib/i18n-server";

/** אוטומציות ← מסעות לקוח: the customer-journey list (drafts, active, paused) and the entry to the builder. */
export default organizationRequest(async function JourneysPage() {
  if (!hasRole(await auth(), ROLES_ADMIN_MANAGER)) return <AccessDenied />;
  const [sequences, t] = await Promise.all([listSequences(), serverT()]);
  return (
    <div className="p-3 sm:p-6">
      <AutomationsTabs />
      <h1 className="mb-1 text-lg font-semibold">{t("מסעות לקוח", "Customer journeys")}</h1>
      <p className="mb-2 text-sm text-muted">{t("רצף פעולות לאורך זמן לכל איש קשר: טריגר, המתנות, תנאים והודעות. חוקי אוטומציה בודדים (טריגר ← פעולה) נמצאים בלשונית ״אוטומציות״.", "A sequence of steps over time for each contact: trigger, waits, conditions and messages. Single automation rules (trigger → action) are in the \"Automations\" tab.")}</p>
      <JourneyList journeys={JSON.parse(JSON.stringify(sequences))} />
    </div>
  );
}, ["whatsapp.automations", "sms.send", "email.send"]);
