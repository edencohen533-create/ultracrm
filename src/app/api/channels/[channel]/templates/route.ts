import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { channelTemplateSchema, deleteChannelTemplate, listChannelTemplates, saveChannelTemplate } from "@/server/services/channel-template-service";

export const dynamic = "force-dynamic";
const channelParam = z.enum(["sms", "email"]);

export const GET = withAuth(async ({ params }) => {
  const channel = channelParam.safeParse(params.channel);
  if (!channel.success) throw new ApiError("ערוץ לא תקין", 400, "bad_channel");
  return ok({ items: await listChannelTemplates(channel.data) });
}, { module: "messaging" });

export const POST = withAuth(async ({ req, user, params }) => {
  const body = await parseBody(req, channelTemplateSchema);
  if (body.channel !== params.channel) throw new ApiError("ערוץ לא תואם", 400, "bad_channel");
  return ok(await saveChannelTemplate(user, body));
}, { minRole: "manager", module: "messaging" });

export const DELETE = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ id: z.string().min(1) }));
  await deleteChannelTemplate(user, b.id);
  return ok({ deleted: true });
}, { minRole: "manager", module: "messaging" });
