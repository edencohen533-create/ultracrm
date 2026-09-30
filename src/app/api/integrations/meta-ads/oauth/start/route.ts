import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { ApiError } from "@/lib/response";
import { OAUTH_COOKIE, oauthStart } from "@/server/marketing/meta-connection";

export const dynamic = "force-dynamic";

/** Official Meta login (ads_read) – redirects to Meta; the browser nonce cookie binds the answer to this browser. */
export async function GET(req: NextRequest) {
  const back = new URL("/settings?tab=connections", req.url);
  try {
    const user = await requireUser(req);
    const { url, nonce } = await oauthStart(user);
    const res = NextResponse.redirect(url);
    res.cookies.set(OAUTH_COOKIE, nonce, { httpOnly: true, secure: req.nextUrl.protocol === "https:", sameSite: "lax", path: "/api/integrations/meta-ads/oauth", maxAge: 600 });
    return res;
  } catch (e) {
    back.searchParams.set("metaAds", "error"); back.searchParams.set("reason", e instanceof ApiError ? e.code : "failed");
    return NextResponse.redirect(back);
  }
}
