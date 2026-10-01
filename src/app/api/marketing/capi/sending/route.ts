import { z } from "zod";
import { assertCapiAccess } from "@/app/api/marketing/capi/_access";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { setSending } from "@/server/marketing/capi";

export const dynamic = "force-dynamic";
export const POST = withAuth(async ({ req, user }) => { await assertCapiAccess(user, true); return ok(await setSending(user, (await parseBody(req, z.object({ enabled: z.boolean() }))).enabled)); }, { perm: "crm.marketing_connect" });
