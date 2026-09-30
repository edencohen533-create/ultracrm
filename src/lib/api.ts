import type { NextRequest } from "next/server";
import { z, type ZodTypeAny } from "zod";
import { requireUser, requireRole, type SessionUser } from "@/lib/auth";
import { ApiError, handleError } from "@/lib/response";
import { withBusiness } from "@/lib/tenant";
import type { ModuleKey, Permission } from "@/lib/access/catalog";
import { assertAccess } from "@/lib/access/engine";
import type { UserRole } from "@/generated/prisma/enums";

type Params = Record<string, string>;
type Handler = (ctx: { req: NextRequest; user: SessionUser; params: Params }) => Promise<Response>;

type Need = ModuleKey | Permission | Array<ModuleKey | Permission>;
export interface WithAuthOptions {
  minRole?: UserRole;
  /**
   * The module(s) this route belongs to (an array = any of them). Rejected with 403 unless the business is entitled
   * to the module AND the business manager assigned it to this user (src/lib/access/engine.ts).
   */
  module?: Need;
  /** A specific action (e.g. "crm.export"); may depend on a route param (e.g. the channel). Default = deny. */
  perm?: Need | ((params: Params) => Need);
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
      const params = ctx?.params ? await ctx.params : {};
      if (opts.module) await assertAccess(user, opts.module);
      if (opts.perm) await assertAccess(user, typeof opts.perm === "function" ? opts.perm(params) : opts.perm);
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
  // A restored copy never runs scheduled work (campaigns, retries, billing, sync…).
  if (process.env.RESTORE_MODE === "1") throw new ApiError("סביבת שחזור – משימות מתוזמנות כבויות", 423, "restore_mode");
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new ApiError("CRON_SECRET is not configured", 500, "cron_not_configured");
  if (req.headers.get("authorization") !== `Bearer ${secret}`) throw new ApiError("לא מורשה", 401, "unauthorized");
}

export const dynamic = "force-dynamic";
