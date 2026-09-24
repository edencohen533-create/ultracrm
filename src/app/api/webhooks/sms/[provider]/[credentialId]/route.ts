import { handleChannelWebhook } from "@/lib/channel-webhook";
export const maxDuration = 60;
export const dynamic = "force-dynamic";
export async function POST(request: Request, ctx: { params: Promise<{ provider: string; credentialId: string }> }) {
  const { provider, credentialId } = await ctx.params;
  return handleChannelWebhook(request, "sms", provider, credentialId);
}
