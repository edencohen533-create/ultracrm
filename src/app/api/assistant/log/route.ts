import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Activity log: request, tools used (names/args/ok/latency – never results or secrets) and the outcome. */
export const GET = withAuth(async ({ req, user }) => {
  const linkId = req.nextUrl.searchParams.get("linkId") ?? undefined;
  const rows = await prisma.assistantMessage.findMany({
    where: { businessId: user.businessId, ...(linkId ? { linkId } : {}), ...(user.role === "owner" ? {} : { link: { userId: user.id } }) },
    orderBy: { createdAt: "desc" }, take: 100,
    select: { id: true, linkId: true, direction: true, text: true, intent: true, tools: true, status: true, error: true, model: true, latencyMs: true, createdAt: true, link: { select: { phoneE164: true, user: { select: { fullName: true } } } } },
  });
  return ok({ items: rows.map(({ link, ...r }) => ({ ...r, user: link?.user.fullName ?? null, phoneLast4: link?.phoneE164.slice(-4) ?? null })) });
}, { minRole: "manager" });
