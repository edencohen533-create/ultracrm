import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { newPublicKey, newWebhookSecret, sealStoreConfig, storeSecret } from "@/server/services/cart-service";
import { maskSecret } from "@/lib/crypto";
import { snippetFor, webhookUrlFor } from "@/lib/store-urls";
import type { StoreConnection } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";
export const storeView = (s: StoreConnection, reveal = false) => ({ id: s.id, platform: s.platform, name: s.name, domain: s.domain, publicKey: s.publicKey, abandonAfterMinutes: s.abandonAfterMinutes, isActive: s.isActive, lastEventAt: s.lastEventAt, createdAt: s.createdAt, snippet: snippetFor(s.publicKey), webhookUrl: s.platform === "custom" ? null : webhookUrlFor(s.platform, s.id), webhookSecret: reveal ? storeSecret(s) : null, webhookSecretMasked: maskSecret(storeSecret(s)) });

export const GET = withAuth(async () => ok({ items: (await prisma.storeConnection.findMany({ orderBy: { createdAt: "asc" } })).map((s) => storeView(s)) }), { minRole: "manager", module: "messaging" });

export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ platform: z.enum(["shopify", "woocommerce", "custom"]), name: z.string().trim().min(1).max(120), domain: z.string().trim().max(200).optional(), abandonAfterMinutes: z.number().int().min(10).max(10080).default(60), webhookSecret: z.string().trim().max(300).optional() }));
  // WooCommerce: we generate the secret the user pastes into WooCommerce. Shopify signs with its own key – the user pastes it here.
  const secret = b.webhookSecret || (b.platform === "shopify" ? "" : newWebhookSecret());
  const s = await prisma.storeConnection.create({ data: { businessId: user.businessId, platform: b.platform, name: b.name, domain: b.domain?.replace(/^https?:\/\//, "").replace(/\/.*$/, "") || null, publicKey: newPublicKey(), abandonAfterMinutes: b.abandonAfterMinutes, config: sealStoreConfig(secret ? { webhookSecret: secret } : {}) } });
  await audit(user.businessId, user.id, "store", s.id, "store.connected", { platform: b.platform });
  return ok(storeView(s, true));
}, { minRole: "manager", module: "messaging" });
