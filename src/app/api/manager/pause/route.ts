import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { getBusinessSettings, mergeSettings } from "@/lib/settings";
import { audit } from "@/lib/audit";
import type { Prisma } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

const schema = z.object({ scope: z.enum(["business", "list"]), listId: z.string().optional(), paused: z.boolean() });

/**
 * Kill switch. Business scope stops every new outbound dial (claims and manual dials);
 * list scope pauses one campaign. Live calls are never interrupted.
 */
export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, schema);
  if (b.scope === "business") {
    const current = await getBusinessSettings(user.businessId);
    const merged = mergeSettings({ ...current, dialingPaused: b.paused });
    await prisma.business.update({ where: { id: user.businessId }, data: { settings: merged as unknown as Prisma.InputJsonValue } });
    await audit(user.businessId, user.id, "settings", user.businessId, b.paused ? "dialing.paused" : "dialing.resumed", { scope: "business" });
    return ok({ dialingPaused: b.paused });
  }
  if (!b.listId) throw new ApiError("listId חובה", 400, "validation");
  const list = await prisma.dialList.findFirst({ where: { id: b.listId, businessId: user.businessId } });
  if (!list) throw new ApiError("רשימה לא נמצאה", 404, "not_found");
  await prisma.dialList.update({ where: { id: list.id }, data: { isPaused: b.paused } });
  await audit(user.businessId, user.id, "list", list.id, b.paused ? "list.paused" : "list.resumed");
  return ok({ listId: list.id, isPaused: b.paused });
}, { minRole: "manager" });
