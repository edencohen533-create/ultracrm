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
  { minRole: "owner", perm: "crm.edit" },
);
export const DELETE = withAuth(
  async ({ user }) => ok(await disconnectMetaAds(user)),
  { minRole: "owner", perm: "crm.edit" },
);
