import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { myRequests } from "@/server/ops/overview";

export const dynamic = "force-dynamic";
/** Agent: extra-leads requests waiting for my answer. */
export const GET = withAuth(async ({ user }) => ok(await myRequests(user)), { module: "crm" });
