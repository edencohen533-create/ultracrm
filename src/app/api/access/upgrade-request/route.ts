import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { accessAudit } from "@/lib/access/manage";
import { MODULES, type ModuleKey } from "@/lib/access/catalog";

export const dynamic = "force-dynamic";
const schema = z.object({ module: z.enum(MODULES as [ModuleKey, ...ModuleKey[]]).optional(), modules: z.array(z.enum(MODULES as [ModuleKey, ...ModuleKey[]])).max(MODULES.length).optional(), note: z.string().trim().max(500).optional() }).refine((b) => b.module || b.modules?.length || b.note, { message: "יש לבחור מודול או לכתוב מה תרצו להוסיף" });
/** A business manager asks for an upgrade – recorded for the platform admin; it never changes the package by itself. */
export const POST = withAuth(async ({ req, user }) => { const b = await parseBody(req, schema); await accessAudit({ businessId: user.businessId, actorAccountId: user.accountId, targetUserId: user.id, action: "upgrade_requested", after: b }); return ok({ requested: true }); }, { minRole: "manager" });
