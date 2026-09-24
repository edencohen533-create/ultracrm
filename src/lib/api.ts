import type { NextRequest } from "next/server";
import { z, type ZodTypeAny } from "zod";
import { requireUser, requireRole, type SessionUser } from "@/lib/auth";
import { ApiError, handleError } from "@/lib/response";
import { withBusiness } from "@/lib/tenant";
import { assertModuleEnabled, type ModuleKey } from "@/lib/modules";
import type { UserRole } from "@/generated/prisma/enums";

type Params = Record<string, string>;
type Handler = (ctx: { req: NextRequest; user: SessionUser; params: Params }) => Promise<Response>;

export interface WithAuthOptions {
  minRole?: UserRole;
  /** The module this route belongs to; rejected with 403 when the business's plan does not enable it. */
  module?: ModuleKey;
}

/**
 * Wrap a route handler with: session + membership check, role check, module
 * check, business context (all queries scoped) and uniform error handling.
 */
export function withAuth(handler: Handler, opts: WithAuthOptions = {}) {
  return async (req: NextRequest, ctx: { params: Promise<Params> }) => {
    try {
      const user = await requireUser(req);
      if (opts.minRole) requireRole(user, opts.minRole);
      if (opts.module) await assertModuleEnabled(user.businessId, opts.module);
      const params = ctx?.params ? await ctx.params : {};
      return await withBusiness(user.businessId, () => handler({ req, user, params }), user);
    } catch (err) {
      return handleError(err);
    }
  };
}

export async function parseBody<T extends ZodTypeAny>(req: NextRequest, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new ApiError("גוף הבקשה אינו JSON תקין", 400, "invalid_json");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError("נתונים לא תקינים", 400, "validation", parsed.error.flatten());
  return parsed.data;
}

export function parseQuery<T extends ZodTypeAny>(req: NextRequest, schema: T): z.infer<T> {
  const obj: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((v, k) => (obj[k] = v));
  const parsed = schema.safeParse(obj);
  if (!parsed.success) throw new ApiError("פרמטרים לא תקינים", 400, "validation", parsed.error.flatten());
  return parsed.data;
}

/** Authenticate a background job route: `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends it automatically). */
export function requireCronSecret(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new ApiError("CRON_SECRET is not configured", 500, "cron_not_configured");
  if (req.headers.get("authorization") !== `Bearer ${secret}`) throw new ApiError("לא מורשה", 401, "unauthorized");
}

export const dynamic = "force-dynamic";
