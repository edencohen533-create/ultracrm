import { z } from "zod";
import { organizationRequest } from "@/lib/auth-compat";
import { campaignActor } from "@/lib/campaign-auth";
import { audienceSchema } from "@/lib/audiences";
import { previewAudience, AudienceError } from "@/server/services/audience-service";
const schema = z.object({ segment: audienceSchema.optional(), listId: z.string().min(1).optional(), excludedListIds: z.array(z.string().min(1)).max(20).optional() }).strict().refine((value) => !!value.segment !== !!value.listId).refine((value) => !value.segment || !value.excludedListIds?.length);
export const POST = organizationRequest(async function(request: Request) {
  if (!await campaignActor()) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const input = schema.safeParse(await request.json().catch(() => null));
  if (!input.success) return Response.json({ error: "יש לבחור קהל או תנאים תקינים" }, { status: 400 });
  try { return Response.json(await previewAudience(input.data)); }
  catch (error) { if (error instanceof AudienceError) return Response.json({ error: error.message }, { status: 400 }); throw error; }
});
export const maxDuration = 60;
