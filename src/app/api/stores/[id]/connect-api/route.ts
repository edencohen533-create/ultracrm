import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { connectShopify, connectWooCommerce } from "@/server/services/store-api";
import { storeView } from "../../route";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const schema = z.union([
  z.object({ shop: z.string().trim().min(3).max(200), accessToken: z.string().trim().min(10).max(300), apiSecret: z.string().trim().min(8).max(300) }),
  z.object({ siteUrl: z.string().trim().min(4).max(300), consumerKey: z.string().trim().min(8).max(200), consumerSecret: z.string().trim().min(8).max(200) }),
]);

/** Verify the store's API credentials and register our webhooks in the store. */
export const POST = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, schema);
  const s = await prisma.storeConnection.findUnique({ where: { id: params.id } });
  if (!s) throw new ApiError("החנות לא נמצאה", 404, "not_found");
  const r = "shop" in b
    ? (s.platform !== "shopify" ? (() => { throw new ApiError("החנות אינה Shopify", 400, "platform_mismatch"); })() : await connectShopify(s, b))
    : (s.platform !== "woocommerce" ? (() => { throw new ApiError("החנות אינה WooCommerce", 400, "platform_mismatch"); })() : await connectWooCommerce(s, b));
  await audit(user.businessId, user.id, "store", s.id, "store.api_connected", { platform: s.platform, registered: r.registered, failed: r.failed });
  return ok({ store: storeView(r.store), registered: r.registered, failed: r.failed, shopName: r.shopName });
}, { minRole: "manager", module: "messaging" });
