import { z } from "zod";
import { withAuth, parseQuery } from "@/lib/api";
import { ok } from "@/lib/response";
import { comparisonReport } from "@/server/reports/comparison";

export const dynamic = "force-dynamic";
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const schema = z.object({
  from: date, to: date, compare: z.enum(["previous", "custom", "none"]).default("previous"),
  compareFrom: date.optional(), compareTo: date.optional(),
  userId: z.string().max(64).optional(), listId: z.string().max(64).optional(), product: z.string().max(160).optional(),
});

/** KPIs for a period and its comparison period (business-timezone days, same filters, user's own scope). */
export const GET = withAuth(async ({ req, user }) => ok(await comparisonReport(user, parseQuery(req, schema))), { minRole: "manager", module: "telephony" });
