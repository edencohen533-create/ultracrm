import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { cancelAction } from "@/server/ai/actions";

export const dynamic = "force-dynamic";
export const POST = withAuth(async ({ user, params }) => { await cancelAction(user, params.id); return ok({ cancelled: true }); });
