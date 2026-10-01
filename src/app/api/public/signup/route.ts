import { NextResponse } from "next/server";
import { handleError } from "@/lib/response";
import { cookieMaxAge, cookieName, sessionFromMembership, signSession } from "@/lib/auth";
import { assertSameOriginMutation } from "@/lib/request-origin";
import { signup } from "@/server/onboarding/signup";

export const dynamic = "force-dynamic";
/** Public signup → isolated business + owner, signed in; continues to the onboarding checklist. */
export async function POST(req: Request) {
  try {
    assertSameOriginMutation(req);
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const r = await signup(await req.json().catch(() => ({})), ip);
    const token = await signSession(sessionFromMembership({ id: r.user.id, businessId: r.business.id, role: "owner", teamId: null, fullName: r.account.fullName, email: r.account.email }, r.account.id, r.account.sessionVersion));
    const res = NextResponse.json({ success: true, data: { businessId: r.business.id, next: "/onboarding" } }, { status: 201 });
    res.cookies.set(cookieName, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: cookieMaxAge, path: "/" });
    return res;
  } catch (e) { return handleError(e); }
}
