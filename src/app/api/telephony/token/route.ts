import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { adapterFor } from "@/lib/telephony";
import { peekProviderForNewCall } from "@/lib/telephony/routing";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Mint a short-lived browser login token for the provider that will carry this agent's next call. Secrets never
 * leave the server. `agentClient` tells the browser which client to load; after a provider switch the dialer
 * reconnects (startCall answers 409 agent_reregister_required).
 */
export const POST = withAuth(async ({ user }) => {
  const provider = await peekProviderForNewCall(user.businessId);
  const telephony = adapterFor(provider);
  const t = await telephony.createBrowserToken(user.id);
  if (telephony.simulation) {
    await prisma.user.update({ where: { id: user.id }, data: { sipUsername: t.sipUsername } });
  }
  return ok({ provider: telephony.name, agentClient: telephony.capabilities.agentClient, simulation: telephony.simulation, token: t.token, sipUsername: t.sipUsername, expiresAt: t.expiresAt.toISOString() });
}, { module: "telephony" });
