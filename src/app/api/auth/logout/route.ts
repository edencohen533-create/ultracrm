import { NextRequest, NextResponse } from "next/server";
import { cookieName, getSessionFromRequest } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (session) {
    const live = await prisma.call.findUnique({ where: { activeForUser: session.id }, select: { id: true } });
    if (!live) {
      await prisma.dialerSession.updateMany({ where: { userId: session.id, status: { in: ["active", "paused"] } }, data: { status: "ended", endedAt: new Date() } });
      await prisma.user.update({ where: { id: session.id }, data: { presence: "offline", presenceAt: new Date() } });
    }
  }
  const res = NextResponse.json({ success: true, data: null });
  res.cookies.set(cookieName, "", { httpOnly: true, maxAge: 0, path: "/" });
  return res;
}
