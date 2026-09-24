import { organizationRequest } from "@/lib/auth-compat";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth-compat";
import { hasRole, ROLES_ADMIN } from "@/lib/auth-compat";
import { activateMockProvider } from "@/server/services/provider-credential-service";

export const POST = organizationRequest(async function() {
  const session = await auth();
  if (!session || !hasRole(session, ROLES_ADMIN)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await activateMockProvider(session.user.id);
  return NextResponse.json({ ok: true });
});
