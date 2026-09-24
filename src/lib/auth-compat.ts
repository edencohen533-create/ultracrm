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

/**
 * Wrap a ported route handler `(request, { params })` OR a server component /
 * layout: authenticate, open the business scope, keep the original signature.
 * Routes answer 401 JSON when unauthenticated; pages redirect to /login.
 */
export function organizationRequest<A extends unknown[], R>(handler: Wrapped<A, R>): Wrapped<A, R> {
  return async (...args: A): Promise<R> => {
    const first = args[0];
    if (first instanceof Request) {
      try {
        const user = await requireUser(first as NextRequest);
        return await withBusiness(user.businessId, () => handler(...args), user);
      } catch (err) {
        return handleError(err) as unknown as R;
      }
    }
    const user = await getValidSession();
    if (!user) redirect("/login");
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
