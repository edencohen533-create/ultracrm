import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { getTelephony } from "@/lib/telephony";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Mint a short-lived browser login token. Secrets never leave the server. */
export const POST = withAuth(async ({ user }) => {
  const telephony = getTelephony();
  const t = await telephony.createBrowserToken(user.id);
  if (telephony.simulation) {
    await prisma.user.update({ where: { id: user.id }, data: { sipUsername: t.sipUsername } });
  }
  return ok({ provider: telephony.name, simulation: telephony.simulation, token: t.token, sipUsername: t.sipUsername, expiresAt: t.expiresAt.toISOString() });
});
