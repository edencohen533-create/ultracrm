import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { checkZadarma } from "@/server/services/zadarma-admin-service";

export const dynamic = "force-dynamic";

/** Read-only check of the business's Zadarma account (no calls, no changes). Owner only. */
export const POST = withAuth(async ({ user }) => ok(await checkZadarma(user.businessId)), { minRole: "owner", module: "telephony" });
