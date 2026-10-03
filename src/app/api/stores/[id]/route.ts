import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { sealStoreConfig } from "@/server/services/cart-service";
import { openConfig } from "@/server/channels/registry";
import { storeView } from "../route";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ params, req }) => {
  const s = await prisma.storeConnection.findUnique({ where: { id: params.id } });
  if (!s) throw new ApiError("החנות לא נמצאה", 404, "not_found");
  return ok(storeView(s, new URL(req.url).searchParams.get("reveal") === "1"));
}, { minRole: "manager", perm: ["whatsapp.automations", "sms.send", "email.send"] });

export const PATCH = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ name: z.string().trim().min(1).max(120).optional(), domain: z.string().trim().max(200).nullable().optional(), abandonAfterMinutes: z.number().int().min(10).max(10080).optional(), isActive: z.boolean().optional(), webhookSecret: z.string().trim().min(8).max(300).optional() }));
  const s = await prisma.storeConnection.findUnique({ where: { id: params.id } });
  if (!s) throw new ApiError("החנות לא נמצאה", 404, "not_found");
  const u = await prisma.storeConnection.update({ where: { id: s.id }, data: { ...(b.name ? { name: b.name } : {}), ...(b.domain !== undefined ? { domain: b.domain ? b.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "") : null } : {}), ...(b.abandonAfterMinutes ? { abandonAfterMinutes: b.abandonAfterMinutes } : {}), ...(b.isActive !== undefined ? { isActive: b.isActive } : {}), ...(b.webhookSecret ? { config: sealStoreConfig({ ...openConfig(s.config), webhookSecret: b.webhookSecret }), webhookStatus: "configured", lastVerifiedEventAt: null } : {}) } });
  await audit(user.businessId, user.id, "store", s.id, "store.updated", { fields: Object.keys(b) });
  return ok(storeView(u));
}, { minRole: "manager", perm: ["whatsapp.automations", "sms.send", "email.send"] });

/** Disconnect – never a delete: carts, orders, customers and history stay; API keys are forgotten. */
export const DELETE = withAuth(async ({ user, params }) => {
  const s = await prisma.storeConnection.findUnique({ where: { id: params.id } });
  if (!s) throw new ApiError("החנות לא נמצאה", 404, "not_found");
  if (s.platform === "woocommerce") { const { disconnectWoo } = await import("@/server/services/woo/connect"); await disconnectWoo(s, { removeWebhooks: true }); }
  else await prisma.storeConnection.update({ where: { id: s.id }, data: { isActive: false, disconnectedAt: new Date() } });
  await audit(user.businessId, user.id, "store", params.id, "store.disconnected", { historyKept: true });
  return ok({ disconnected: true });
}, { minRole: "manager", perm: ["whatsapp.automations", "sms.send", "email.send"] });
