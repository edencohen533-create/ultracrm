import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { listPlans, requirePlatformAdmin, savePlan } from "@/lib/access/manage";

export const dynamic = "force-dynamic";
export const GET = withAuth(async ({ user }) => { await requirePlatformAdmin(user); return ok({ items: await listPlans() }); });
export const POST = withAuth(async ({ req, user }) => { await requirePlatformAdmin(user); return ok(await savePlan(user, await req.json().catch(() => null)), 201); });
