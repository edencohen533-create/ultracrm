import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { sealStoreConfig } from "@/server/services/cart-service";
import { storeView } from "../route";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ params, req }) => {
  const s = await prisma.storeConnection.findUnique({ where: { id: params.id } });
  if (!s) throw new ApiError("החנות לא נמצאה", 404, "not_found");
  return ok(storeView(s, new URL(req.url).searchParams.get("reveal") === "1"));
}, { minRole: "manager", module: "messaging" });

export const PATCH = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ name: z.string().trim().min(1).max(120).optional(), domain: z.string().trim().max(200).nullable().optional(), abandonAfterMinutes: z.number().int().min(10).max(10080).optional(), isActive: z.boolean().optional(), webhookSecret: z.string().trim().min(8).max(300).optional() }));
  const s = await prisma.storeConnection.findUnique({ where: { id: params.id } });
  if (!s) throw new ApiError("החנות לא נמצאה", 404, "not_found");
  const u = await prisma.storeConnection.update({ where: { id: s.id }, data: { ...(b.name ? { name: b.name } : {}), ...(b.domain !== undefined ? { domain: b.domain ? b.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "") : null } : {}), ...(b.abandonAfterMinutes ? { abandonAfterMinutes: b.abandonAfterMinutes } : {}), ...(b.isActive !== undefined ? { isActive: b.isActive } : {}), ...(b.webhookSecret ? { config: sealStoreConfig({ webhookSecret: b.webhookSecret }) } : {}) } });
  await audit(user.businessId, user.id, "store", s.id, "store.updated", { fields: Object.keys(b) });
  return ok(storeView(u));
}, { minRole: "manager", module: "messaging" });

export const DELETE = withAuth(async ({ user, params }) => {
  const r = await prisma.storeConnection.deleteMany({ where: { id: params.id } });
  if (!r.count) throw new ApiError("החנות לא נמצאה", 404, "not_found");
  await audit(user.businessId, user.id, "store", params.id, "store.disconnected");
  return ok({ deleted: true });
}, { minRole: "manager", module: "messaging" });
