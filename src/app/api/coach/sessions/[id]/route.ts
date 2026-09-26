import { withAuth } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/** One coached call: transcript segments, every recommendation with its sources, and the examples extracted from it. */
export const GET = withAuth(async ({ params }) => {
  const s = await prisma.coachSession.findUnique({ where: { id: params.id }, include: { segments: { orderBy: { createdAt: "asc" } }, recommendations: { orderBy: { createdAt: "asc" } }, call: { select: { id: true, createdAt: true, outcome: true, talkSeconds: true, recordingStatus: true, user: { select: { fullName: true } }, contact: { select: { id: true, fullName: true } } } } } });
  if (!s) throw new ApiError("סשן לא נמצא", 404, "not_found");
  const examples = await prisma.coachExample.findMany({ where: { callId: s.callId }, orderBy: { createdAt: "asc" } });
  const exampleIds = [...new Set(s.recommendations.flatMap((r) => ((r.sources as { exampleIds?: string[] })?.exampleIds ?? [])))];
  const sourceExamples = exampleIds.length ? await prisma.coachExample.findMany({ where: { id: { in: exampleIds } }, select: { id: true, objection: true, agentResponse: true, editedResponse: true, outcome: true, callId: true, quote: true } }) : [];
  return ok({ session: { ...s, costUsd: Number(s.costUsd) }, examples, sourceExamples });
}, { minRole: "manager" });
