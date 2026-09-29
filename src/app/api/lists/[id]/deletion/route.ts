import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { listDeletionInfo } from "@/lib/dialer/list-admin";

export const dynamic = "force-dynamic";

/** What deleting the list affects – shown in the confirmation (leads, calls in progress, open sessions). */
export const GET = withAuth(async ({ user, params }) => ok(await listDeletionInfo(user, params.id)), { minRole: "manager", perm: "telephony.team_settings" });
