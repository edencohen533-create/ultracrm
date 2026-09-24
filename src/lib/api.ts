import type { NextRequest } from "next/server";
import { z, type ZodTypeAny } from "zod";
import { requireUser, requireRole, type SessionUser } from "@/lib/auth";
import { ApiError, handleError } from "@/lib/response";
import type { UserRole } from "@/generated/prisma/enums";

type Params = Record<string, string>;
type Handler = (ctx: { req: NextRequest; user: SessionUser; params: Params }) => Promise<Response>;

/** Wrap a route handler with auth, role check and uniform error handling. */
export function withAuth(handler: Handler, opts: { minRole?: UserRole } = {}) {
  return async (req: NextRequest, ctx: { params: Promise<Params> }) => {
    try {
      const user = await requireUser(req);
      if (opts.minRole) requireRole(user, opts.minRole);
      const params = ctx?.params ? await ctx.params : {};
      return await handler({ req, user, params });
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

export const dynamic = "force-dynamic";
