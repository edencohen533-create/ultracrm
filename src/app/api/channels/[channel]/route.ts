import { z } from "zod";
import { withAuth } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { listChannelCredentials, saveChannelCredential } from "@/server/services/channel-credential-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const channelParam = z.enum(["sms", "email"]);

/** Provider connections of a channel (secrets masked). Managers and owners. */
export const GET = withAuth(async ({ params }) => {
  const channel = channelParam.safeParse(params.channel);
  if (!channel.success) throw new ApiError("ערוץ לא תקין", 400, "bad_channel");
  return ok({ items: await listChannelCredentials(channel.data) });
}, { minRole: "manager", module: "messaging" });

/** Create/replace the connection of a channel and run the provider check. Owner only. */
export const POST = withAuth(async ({ req, user, params }) => {
  const channel = channelParam.safeParse(params.channel);
  if (!channel.success) throw new ApiError("ערוץ לא תקין", 400, "bad_channel");
  const body = await req.json().catch(() => null);
  try { return ok(await saveChannelCredential(user, channel.data, body)); }
  catch (err) { if (err instanceof z.ZodError) throw new ApiError(err.issues[0]?.message ?? "פרטי חיבור לא תקינים", 400, "validation", err.issues); throw err; }
}, { minRole: "owner", module: "messaging" });
