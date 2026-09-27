import { organizationRequest } from "@/lib/auth-compat";
import { auth, hasRole, ROLES_ADMIN_MANAGER } from "@/lib/auth-compat";
import { AccessDenied } from "@/components/shared/access-denied";
import { AutomationsTabs } from "@/components/automations/AutomationsTabs";
import { IntegrationsScreen } from "@/components/automations/IntegrationsScreen";

export default organizationRequest(async function IntegrationsPage() {
  if (!hasRole(await auth(), ROLES_ADMIN_MANAGER)) return <AccessDenied />;
  return <div className="p-3 sm:p-6 max-w-5xl"><AutomationsTabs /><h1 className="text-lg font-semibold mb-3">Webhooks ו-API</h1><IntegrationsScreen /></div>;
});
