import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { closeDeal, closeDealSchema } from "@/lib/crm/deal-close";

export const dynamic = "force-dynamic";

/** "עסקה נסגרה" popup: won deal + products (with service period) + note + existing-customers dialer list. */
export const POST = withAuth(async ({ req, user }) => ok(await closeDeal(user, await parseBody(req, closeDealSchema)), 201), { module: "crm" });
