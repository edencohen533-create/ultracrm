import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { reportFilterOptions } from "@/server/reports/comparison";

export const dynamic = "force-dynamic";
/** Agents (in the user's scope), campaigns (dial lists) and products available for filtering reports. */
export const GET = withAuth(async ({ user }) => ok(await reportFilterOptions(user)), { minRole: "manager", module: "telephony" });
