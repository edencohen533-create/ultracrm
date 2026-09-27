import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { automationRuns, describe } from "@/server/ai/automations";
import { assertCanManage, getAiSettings } from "@/server/ai/settings";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ user, params }) => {
  assertCanManage(user, (await getAiSettings(user.businessId)).ai);
  const s = await prisma.marketingSequence.findFirst({ where: { id: params.id, businessId: user.businessId } });
  if (!s) throw new ApiError("האוטומציה לא נמצאה", 404, "not_found");
  return ok({ id: s.id, name: s.name, isActive: s.isActive, versionAt: s.updatedAt, description: await describe(s.id), runs: await automationRuns(user.businessId, s.id) });
});

/** Pause (immediate) or activate THE SHOWN version: `versionAt` must equal the current version (explicit approval). */
const schema = z.object({ action: z.enum(["pause", "activate"]), versionAt: z.string().optional() });
export const POST = withAuth(async ({ req, user, params }) => {
  assertCanManage(user, (await getAiSettings(user.businessId)).ai);
  const b = await parseBody(req, schema);
  const s = await prisma.marketingSequence.findFirst({ where: { id: params.id, businessId: user.businessId } });
  if (!s) throw new ApiError("האוטומציה לא נמצאה", 404, "not_found");
  if (b.action === "activate" && s.updatedAt.toISOString() !== b.versionAt) throw new ApiError("האוטומציה השתנתה מאז שהוצגה – רענן ובדוק שוב לפני הפעלה", 409, "changed");
  const r = await prisma.marketingSequence.updateMany({ where: { id: s.id, updatedAt: s.updatedAt }, data: { isActive: b.action === "activate" } });
  if (!r.count) throw new ApiError("האוטומציה השתנתה – נסה שוב", 409, "changed");
  await audit(user.businessId, user.id, "sequence", s.id, b.action === "activate" ? "ai.automation_activated" : "ai.automation_paused", { versionAt: s.updatedAt.toISOString() });
  return ok({ isActive: b.action === "activate" });
});
