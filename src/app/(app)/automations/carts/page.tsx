import { organizationRequest } from "@/lib/auth-compat";
import { auth, hasRole, ROLES_ADMIN_MANAGER } from "@/lib/auth-compat";
import { AccessDenied } from "@/components/shared/access-denied";
import { AutomationsTabs } from "@/components/automations/AutomationsTabs";
import { CartsScreen } from "@/components/carts/carts-screen";

export default organizationRequest(async function AutomationCartsPage() {
  if (!hasRole(await auth(), ROLES_ADMIN_MANAGER)) return <AccessDenied />;
  return <div className="p-3 sm:p-6"><AutomationsTabs /><CartsScreen /></div>;
});
