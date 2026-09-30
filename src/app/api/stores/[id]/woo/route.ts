import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { recheckWoo, ensureWooWebhooks, disconnectWoo } from "@/server/services/woo/connect";
import { previewSync, startSync, resumeSync, runSyncStep, startReconcile } from "@/server/services/woo/sync";
import { processStoreEvents, reprocessFailed } from "@/server/services/woo/events";
import { storeHealth } from "@/server/services/woo/health";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const PERM = { minRole: "manager" as const, perm: ["whatsapp.automations", "sms.send", "email.send"] as never };

async function wooStore(id: string) {
  const s = await prisma.storeConnection.findUnique({ where: { id } });
  if (!s) throw new ApiError("החנות לא נמצאה", 404, "not_found");
  if (s.platform !== "woocommerce") throw new ApiError("החנות אינה WooCommerce", 400, "platform_mismatch");
  return s;
}

/** Connection status (each part separately). The manual webhook secret only with ?reveal=1 (managers). */
export const GET = withAuth(async ({ params, req }) => {
  const s = await wooStore(params.id);
  return ok(await storeHealth(s, { revealManualSecret: new URL(req.url).searchParams.get("reveal") === "1" }));
}, PERM);

const scope = z.object({ orders: z.enum(["none", "30", "90", "365", "all"]), customers: z.boolean(), products: z.boolean() });
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("test") }),
  z.object({ action: z.literal("webhooks") }),
  z.object({ action: z.literal("preview"), scope }),
  z.object({ action: z.literal("start"), scope }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("step") }),
  z.object({ action: z.literal("sync_now") }),
  z.object({ action: z.literal("reprocess") }),
  z.object({ action: z.literal("disconnect"), removeWebhooks: z.boolean().default(true) }),
]);

export const POST = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, schema);
  const s = await wooStore(params.id);
  const log = (action: string, payload: Record<string, unknown> = {}) => audit(user.businessId, user.id, "store", s.id, `store.woo_${action}`, payload);
  switch (b.action) {
    case "test": { const t = await recheckWoo(s); await log("test", { access: t.access, problems: t.problems }); break; }
    case "webhooks": { const r = await ensureWooWebhooks(s); await log("webhooks", { status: r.status, created: r.created, repaired: r.repaired, failed: r.failed }); break; }
    case "preview": return ok({ counts: await previewSync(s, b.scope) });
    case "start": { await startSync(s, b.scope, "initial"); await log("sync_start", { scope: b.scope }); await runSyncStep(s.id, Date.now() + 15_000); break; }
    case "resume": { await resumeSync(s); await runSyncStep(s.id, Date.now() + 15_000); break; }
    case "step": { await runSyncStep(s.id, Date.now() + 15_000); await processStoreEvents({ storeId: s.id, deadline: Date.now() + 5_000 }); break; }
    case "sync_now": { await startReconcile(s); await log("sync_now"); await runSyncStep(s.id, Date.now() + 15_000); break; }
    case "reprocess": { const n = await reprocessFailed(s.id); await log("reprocess", { events: n }); await processStoreEvents({ storeId: s.id, deadline: Date.now() + 15_000 }); break; }
    case "disconnect": { const r = await disconnectWoo(s, { removeWebhooks: b.removeWebhooks }); await log("disconnect", r); break; }
  }
  return ok(await storeHealth(await prisma.storeConnection.findUniqueOrThrow({ where: { id: s.id } })));
}, PERM);
