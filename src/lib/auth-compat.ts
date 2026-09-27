/**
 * Compatibility layer for code ported from solinainbox, which was written
 * against NextAuth (`auth()` returning a `Session`) and an "organization"
 * request wrapper. Both now resolve to the UltraCRM session (jose cookie) and
 * the business context established by `withAuth`.
 */
import type { NextRequest } from "next/server";
import { redirect } from "next/navigation";
import { getValidSession, requireUser, type SessionUser } from "@/lib/auth";
import { handleError } from "@/lib/response";
import { currentSessionUser, withBusiness } from "@/lib/tenant";
import { assertAccess } from "@/lib/access/engine";
import type { ModuleKey, Permission } from "@/lib/access/catalog";
import { ApiError } from "@/lib/response";
import type { UserRole } from "@/generated/prisma/enums";

export interface Session {
  user: {
    id: string;
    businessId: string;
    role: UserRole;
    teamId: string | null;
    name: string;
    email: string;
  };
}

export function toSession(u: SessionUser): Session {
  return { user: { id: u.id, businessId: u.businessId, role: u.role, teamId: u.teamId, name: u.fullName, email: u.email } };
}

/** The session of the request that opened the current business scope (null outside a request). */
export async function auth(): Promise<Session | null> {
  const u = currentSessionUser();
  return u ? toSession(u) : null;
}

type Wrapped<A extends unknown[], R> = (...args: A) => Promise<R>;
type Need = ModuleKey | Permission | Array<ModuleKey | Permission>;
/** Static requirement, or computed inside the business scope from the request (e.g. the campaign's channel). */
export type AccessNeed = Need | ((request: Request | null, params: Record<string, string>) => Need | Promise<Need>);
/** Ported messaging routes belonged to "messaging" = any of WhatsApp / SMS / email. */
const ANY_MESSAGING: Need = ["whatsapp", "sms", "email"];

/**
 * Wrap a ported route handler `(request, { params })` OR a server component /
 * layout: authenticate, open the business scope, check module + action access (src/lib/access), keep the
 * original signature. Routes answer 401/403 JSON; pages redirect to /login or show /no-access.
 */
export function organizationRequest<A extends unknown[], R>(handler: Wrapped<A, R>, need: AccessNeed = ANY_MESSAGING): Wrapped<A, R> {
  return async (...args: A): Promise<R> => {
    const first = args[0];
    // Route handlers: (request, { params }); pages: ({ params, searchParams }).
    const paramsOf = async () => { const c = (first instanceof Request ? args[1] : first) as { params?: Promise<Record<string, string>> } | undefined; return (c?.params ? await c.params : {}) ?? {}; };
    if (first instanceof Request) {
      try {
        const user = await requireUser(first as NextRequest);
        const params = await paramsOf();
        return await withBusiness(user.businessId, async () => {
          const n = typeof need === "function" ? await need(first, params) : need;
          await assertAccess(user, n);
          return handler(...args);
        }, user);
      } catch (err) {
        return handleError(err) as unknown as R;
      }
    }
    const user = await getValidSession();
    if (!user) redirect("/login");
    const params = await paramsOf();
    const denied = await withBusiness(user.businessId, async () => {
      try { await assertAccess(user, typeof need === "function" ? await need(null, params) : need); return null; }
      catch (e) { if (e instanceof ApiError) return e; throw e; }
    }, user);
    if (denied) redirect(`/no-access?reason=${encodeURIComponent(denied.code)}`);
    return withBusiness(user.businessId, () => handler(...args), user);
  };
}

export const ROLES_OWNER: UserRole[] = ["owner"];
export const ROLES_ADMIN: UserRole[] = ["owner"];
export const ROLES_ADMIN_MANAGER: UserRole[] = ["owner", "manager"];
export const ROLES_ALL: UserRole[] = ["owner", "manager", "agent"];

export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export function hasRole(session: Session | null, allowed: UserRole[]): boolean {
  return !!session?.user && allowed.includes(session.user.role);
}

export function requireRole(session: Session | null, allowed: UserRole[]): asserts session is Session {
  if (!hasRole(session, allowed)) throw new ForbiddenError();
}
