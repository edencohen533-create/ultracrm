import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { deleteSequence, saveSequence, sequenceSchema } from "@/server/services/sequence-service";

export const dynamic = "force-dynamic";
export const GET = withAuth(async ({ params }) => ok({ runs: await prisma.sequenceRun.findMany({ where: { sequenceId: params.id }, orderBy: { startedAt: "desc" }, take: 100, include: { contact: { select: { id: true, fullName: true } } } }) }), { minRole: "manager", module: "messaging" });
export const PUT = withAuth(async ({ req, user, params }) => ok(await saveSequence(user, await parseBody(req, sequenceSchema), params.id)), { minRole: "manager", module: "messaging" });
export const DELETE = withAuth(async ({ user, params }) => { await deleteSequence(user, params.id); return ok({ deleted: true }); }, { minRole: "manager", module: "messaging" });
