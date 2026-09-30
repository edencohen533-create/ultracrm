import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertIntegrationAdmin } from "@/server/crm-sync/connections";
import { createIntegrationKey } from "@/server/services/integrations";

export const dynamic = "force-dynamic";

/** Integration keys of this connection (prefix only – a key is shown once, at creation). */
export const GET = withAuth(async ({ user, params }) => {
  await assertIntegrationAdmin(user);
  return ok({ items: await prisma.apiKey.findMany({ where: { businessId: user.businessId, connectionId: params.id }, orderBy: { createdAt: "desc" }, select: { id: true, name: true, prefix: true, scopes: true, lastUsedAt: true, revokedAt: true, expiresAt: true, createdAt: true, rotatedFromId: true } }) });
});
export const POST = withAuth(async ({ req, user, params }) => {
  await assertIntegrationAdmin(user);
  const b = await parseBody(req, z.object({ name: z.string().trim().max(80).default("מפתח אינטגרציה"), scopes: z.array(z.string().max(40)).min(1).max(10) }));
  const k = await createIntegrationKey(user, { name: b.name, connectionId: params.id, scopes: b.scopes });
  await audit(user.businessId, user.id, "business", user.businessId, "crm_sync.key_created", { connectionId: params.id, keyId: k.id, scopes: k.scopes });
  return ok(k, 201);
});
