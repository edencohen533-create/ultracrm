import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Recent calls of this agent (for redial). */
export const GET = withAuth(async ({ user }) => {
  const calls = await prisma.call.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 15,
    select: { id: true, toE164: true, createdAt: true, telephonyResult: true, outcome: true, talkSeconds: true, contact: { select: { id: true, fullName: true } } },
  });
  return ok(calls);
});
