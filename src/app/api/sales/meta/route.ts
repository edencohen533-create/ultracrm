import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import {
  metaAdStatus,
  connectMetaAds,
  disconnectMetaAds,
} from "@/server/sales/meta-ads";
export const GET = withAuth(async ({ user }) => ok(await metaAdStatus(user)), {
  perm: "crm.view",
});
export const POST = withAuth(
  async ({ user, req }) => ok(await connectMetaAds(user, await req.json())),
  { perm: "crm.marketing_connect" },
);
export const DELETE = withAuth(
  async ({ user }) => ok(await disconnectMetaAds(user)),
  { perm: "crm.marketing_connect" },
);
