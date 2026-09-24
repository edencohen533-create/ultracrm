import { z } from "zod";
import { organizationRequest } from "@/lib/auth-compat";
import { MetaConnectionError } from "@/server/services/meta-connection-service";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth-compat";
import { hasRole, ROLES_ADMIN } from "@/lib/auth-compat";
import { metaProviderConfigSchema } from "@/lib/validation/provider";
import { activateMetaProvider, getActiveProviderSummary } from "@/server/services/provider-credential-service";

export const GET = organizationRequest(async function() {
  const session = await auth();
  if (!session || !hasRole(session, ROLES_ADMIN)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const summary = await getActiveProviderSummary();
  return NextResponse.json(summary);
});

export const POST = organizationRequest(async function(request: Request) {
  const session = await auth();
  if (!session || !hasRole(session, ROLES_ADMIN)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = metaProviderConfigSchema.extend({ label: z.string().trim().max(100).optional(), teamId: z.string().min(1).nullable().optional(), makeDefault: z.boolean().optional() }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try { const { label, teamId, makeDefault, ...config } = parsed.data; await activateMetaProvider(config, session.user.id, { label, teamId, makeDefault }); }
  catch (error) {
    if (error instanceof MetaConnectionError) return NextResponse.json({ error: error.message }, { status: 422 });
    throw error;
  }
  return NextResponse.json({ ok: true });
});

export const maxDuration = 60;
