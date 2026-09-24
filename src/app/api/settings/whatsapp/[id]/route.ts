import { organizationRequest } from "@/lib/auth-compat";
import { auth } from "@/lib/auth-compat";
import { z } from "zod";
import { updateProvider } from "@/server/services/provider-credential-service";
import { MetaConnectionError } from "@/server/services/meta-connection-service";
const schema = z.object({ action: z.enum(["disconnect", "default", "details", "reconnect"]), label: z.string().trim().max(100).optional(), teamId: z.string().min(1).nullable().optional() }).strict();
export const maxDuration = 60;
export const PATCH = organizationRequest(async function(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (session?.user.role !== "owner") return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "פרטי מספר לא תקינים" }, { status: 400 });
  try { await updateProvider((await params).id, parsed.data, session.user.id); return Response.json({ ok: true }); }
  catch (error) { if (error instanceof MetaConnectionError) return Response.json({ error: error.message }, { status: 409 }); throw error; }
});
