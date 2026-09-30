import { z } from "zod";
import { withAuth, parseQuery } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { visibleUserIds } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Recorded calls the manager may pick from (their visibility scope), marking the ones already in the coach. */
export const GET = withAuth(async ({ req, user }) => {
  const f = parseQuery(req, z.object({ q: z.string().max(100).optional() }));
  const visible = await visibleUserIds(user);
  const calls = await prisma.call.findMany({ where: { businessId: user.businessId, recordingStatus: "saved", recordingId: { not: null }, answeredAt: { not: null }, ...(visible ? { userId: { in: visible } } : {}), ...(f.q ? { contact: { OR: [{ fullName: { contains: f.q, mode: "insensitive" } }, { phoneE164: { contains: f.q.replace(/\D/g, "") || f.q } }] } } : {}) },
    orderBy: { createdAt: "desc" }, take: 30, select: { id: true, createdAt: true, talkSeconds: true, outcome: true, contact: { select: { fullName: true } }, user: { select: { fullName: true } } } });
  const used = await prisma.salesRecording.findMany({ where: { businessId: user.businessId, callId: { in: calls.map((c) => c.id) }, status: { not: "deleted" } }, select: { callId: true, id: true } });
  return ok({ items: calls.map((c) => ({ ...c, salesRecordingId: used.find((u) => u.callId === c.id)?.id ?? null })) });
}, { minRole: "manager", module: "telephony", perm: "telephony.recordings" });
