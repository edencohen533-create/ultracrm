import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { createApiKey } from "@/server/services/integrations";

export const dynamic = "force-dynamic";

export const GET = withAuth(async () => {
  const items = await prisma.apiKey.findMany({ orderBy: { createdAt: "desc" }, select: { id: true, name: true, prefix: true, lastUsedAt: true, revokedAt: true, createdAt: true } });
  return ok({ items });
}, { minRole: "manager" });

/** Creates a key and returns it ONCE (only its hash is stored). */
export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ name: z.string().trim().min(1).max(80) }));
  const k = await createApiKey(user, b.name);
  await audit(user.businessId, user.id, "api_key", k.id, "api_key.created", { name: k.name, prefix: k.prefix });
  return ok(k, 201);
}, { minRole: "manager" });
