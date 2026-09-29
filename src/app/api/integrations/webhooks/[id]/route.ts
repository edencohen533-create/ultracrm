import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertPublicHttpsUrl } from "@/lib/safe-url";
import { endpointSchema, endpointView } from "@/server/services/integrations";

export const dynamic = "force-dynamic";

async function find(id: string) { const e = await prisma.webhookEndpoint.findUnique({ where: { id } }); if (!e) throw new ApiError("ה-Webhook לא נמצא", 404, "not_found"); return e; }

export const GET = withAuth(async ({ params, req }) => ok(endpointView(await find(params.id), req.nextUrl.searchParams.get("reveal") === "1")), { minRole: "owner" });

export const PATCH = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, endpointSchema.partial());
  const e = await find(params.id);
  const u = await prisma.webhookEndpoint.update({ where: { id: e.id }, data: { ...(b.url ? { url: assertPublicHttpsUrl(b.url, "כתובת ה-Webhook").toString() } : {}), ...(b.description !== undefined ? { description: b.description || null } : {}), ...(b.events ? { events: [...new Set(b.events)] } : {}), ...(b.isActive !== undefined ? { isActive: b.isActive, ...(b.isActive ? { failureCount: 0 } : {}) } : {}) } });
  await audit(user.businessId, user.id, "webhook", e.id, "webhook.updated", { fields: Object.keys(b) });
  return ok(endpointView(u));
}, { minRole: "owner" });

export const DELETE = withAuth(async ({ user, params }) => {
  const e = await find(params.id);
  await prisma.webhookEndpoint.delete({ where: { id: e.id } });
  await audit(user.businessId, user.id, "webhook", e.id, "webhook.deleted", { url: e.url });
  return ok({ deleted: true });
}, { minRole: "owner" });
