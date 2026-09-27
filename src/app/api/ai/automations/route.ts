import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { listAutomations } from "@/server/ai/automations";
import { assertCanManage, getAiSettings } from "@/server/ai/settings";

export const dynamic = "force-dynamic";
export const GET = withAuth(async ({ user }) => { assertCanManage(user, (await getAiSettings(user.businessId)).ai); return ok({ items: await listAutomations(user.businessId) }); });
