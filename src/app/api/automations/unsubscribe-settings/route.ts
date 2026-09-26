import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { getBusinessSettings } from "@/lib/settings";
import { audit } from "@/lib/audit";
import type { Prisma } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

/** "תשובת הסר" automation: remove from lists / tag on unsubscribe (managers). */
export const GET = withAuth(async ({ user }) => ok((await getBusinessSettings(user.businessId)).automations.unsubscribe), { minRole: "manager", module: "messaging" });

export const PATCH = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ removeFromLists: z.boolean(), tagName: z.string().trim().max(40).nullable() }));
  await prisma.$executeRaw`UPDATE "businesses" SET "settings" = jsonb_set(jsonb_set(COALESCE("settings", '{}'::jsonb), '{automations}', COALESCE("settings"->'automations', '{}'::jsonb)), '{automations,unsubscribe}', ${JSON.stringify({ removeFromLists: b.removeFromLists, tagName: b.tagName || null })}::jsonb) WHERE "id" = ${user.businessId}`;
  await audit(user.businessId, user.id, "settings", user.businessId, "settings.updated", { changed: { unsubscribeAutomation: b } as unknown as Prisma.InputJsonValue });
  return ok((await getBusinessSettings(user.businessId)).automations.unsubscribe);
}, { minRole: "manager", module: "messaging" });
