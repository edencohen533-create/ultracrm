import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyTrackedLink } from "@/lib/unsubscribe-token";

export const dynamic = "force-dynamic";

/** Click tracking redirect: records the first click on the message (a provider-independent signal) and redirects. */
export async function GET(_request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const link = verifyTrackedLink(token);
  if (!link) return new NextResponse("הקישור אינו תקף", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  await db.message.updateMany({ where: { id: link.m, clickedAt: null }, data: { clickedAt: new Date() } });
  return NextResponse.redirect(link.u, 302);
}
