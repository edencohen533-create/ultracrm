import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { ApiError } from "@/lib/response";
import { withBusiness } from "@/lib/tenant";
import { OAUTH_COOKIE, oauthCallback } from "@/server/marketing/meta-connection";

export const dynamic = "force-dynamic";

/** Meta redirects here with ?code&state (or ?error). The signed state must match this user, business and browser. */
export async function GET(req: NextRequest) {
  const back = new URL("/settings?tab=connections", req.url);
  const q = req.nextUrl.searchParams;
  try {
    const user = await requireUser(req);
    await withBusiness(user.businessId, () => oauthCallback(user, { code: q.get("code"), state: q.get("state"), error: q.get("error"), nonce: req.cookies.get(OAUTH_COOKIE)?.value }), user);
    back.searchParams.set("metaAds", "connected");
  } catch (e) {
    back.searchParams.set("metaAds", "error"); back.searchParams.set("reason", e instanceof ApiError ? e.code : "failed");
    if (!(e instanceof ApiError)) console.error("[meta-ads oauth]", (e as Error).message);
  }
  const res = NextResponse.redirect(back);
  res.cookies.delete({ name: OAUTH_COOKIE, path: "/api/integrations/meta-ads/oauth" });
  return res;
}
