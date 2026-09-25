import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { sendChannelTest } from "@/server/services/channel-send-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Test send of a template to an explicitly configured test recipient. */
export const POST = withAuth(async ({ req, user, params }) => {
  const channel = z.enum(["sms", "email"]).safeParse(params.channel);
  if (!channel.success) throw new ApiError("ערוץ לא תקין", 400, "bad_channel");
  const b = await parseBody(req, z.object({ templateId: z.string().min(1), to: z.string().trim().min(3).max(200), variables: z.record(z.string(), z.string().max(1024)).optional(), senderId: z.string().max(40).nullable().optional(), credentialId: z.string().nullable().optional() }));
  return ok(await sendChannelTest(user, { channel: channel.data, ...b }));
}, { minRole: "manager", module: "messaging" });
