/**
 * Business (tenant) context.
 *
 * The active business is never taken from the browser. It is established by a
 * trusted entry point only:
 *   • `withAuth` (API routes / server components) – from the verified session, or
 *   • webhook / cron runners – from the record they verified (credential, call, cron scan).
 *
 * `prisma` (src/lib/db.ts) reads this context and scopes every query of a
 * business-owned model to the current business automatically. Explicit
 * `businessId` filters in code are still expected – the context is defence in depth.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionUser } from "@/lib/auth";

interface TenantStore {
  businessId: string;
  session?: SessionUser;
}

// One storage for the whole process. Bundlers (Turbopack dev in particular) can instantiate this
// module once per route chunk while the Prisma client – cached on globalThis – closes over a
// single instance; sharing the storage on globalThis keeps every copy in sync.
const g = globalThis as unknown as { __ultracrmTenantStorage?: AsyncLocalStorage<TenantStore> };
const storage = (g.__ultracrmTenantStorage ??= new AsyncLocalStorage<TenantStore>());

export function withBusiness<T>(businessId: string, operation: () => T, session?: SessionUser): T {
  if (!businessId) throw new Error("Business context is required");
  return storage.run({ businessId, session }, () => {
    const result = operation();
    // Prisma queries are lazy (they run on `.then`). If the callback returns a thenable
    // without awaiting it, settle it *inside* the scope so the query still sees the tenant.
    if (result && typeof (result as { then?: unknown }).then === "function") {
      return (async () => await (result as unknown as Promise<unknown>))() as unknown as T;
    }
    return result;
  });
}

/** The current business id or `null` when running outside a tenant scope (login, webhook routing, cron enumeration). */
export function currentBusinessId(): string | null {
  return storage.getStore()?.businessId ?? null;
}

export function requireBusinessId(): string {
  const id = currentBusinessId();
  if (!id) throw new Error("Business context is required");
  return id;
}

/** The authenticated user that opened this scope (absent inside cron / webhook scopes). */
export function currentSessionUser(): SessionUser | undefined {
  return storage.getStore()?.session;
}
