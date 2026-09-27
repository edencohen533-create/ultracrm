import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const schema = z.object({ mode: z.enum(["all", "selected"]).optional(), agentIds: z.array(z.string()).max(500) });

/**
 * Who may work this campaign: "all" = every agent of the business (stored as no rows), "selected" = only the chosen
 * agents (at least one – an empty selection must never silently mean "everyone"). Enforced on the server when
 * campaigns are listed / counted / opened and when a session or dial starts.
 */
export const PUT = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, schema);
  const list = await prisma.dialList.findFirst({ where: { id: params.id, businessId: user.businessId } });
  if (!list) throw new ApiError("רשימה לא נמצאה", 404, "not_found");
  const wanted = b.mode === "all" ? [] : [...new Set(b.agentIds)];
  if (b.mode === "selected" && !wanted.length) throw new ApiError("יש לבחור לפחות נציג אחד, או לפתוח את הקמפיין לכל הנציגים", 400, "no_agents");
  const users = await prisma.user.findMany({ where: { id: { in: wanted }, businessId: user.businessId, isActive: true }, select: { id: true } });
  if (users.length !== wanted.length) throw new ApiError("אחד המשתמשים שנבחרו אינו פעיל בעסק", 400, "invalid_agent");
  await prisma.$transaction([
    prisma.dialListAgent.deleteMany({ where: { listId: list.id } }),
    prisma.dialListAgent.createMany({ data: users.map((u) => ({ listId: list.id, userId: u.id })) }),
  ]);
  await audit(user.businessId, user.id, "dial_list", list.id, "dial_list.agents_updated", { mode: wanted.length ? "selected" : "all", agentIds: wanted });
  return ok({ mode: wanted.length ? "selected" : "all", agentIds: users.map((u) => u.id) });
}, { minRole: "manager", perm: "telephony.team_settings" });
