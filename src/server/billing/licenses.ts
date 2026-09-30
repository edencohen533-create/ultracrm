/**
 * Licenses = purchased seats. Assigning gives a user the module; moving it to another employee frees the first seat
 * and takes it for the second – no extra purchase. One license = one person at a time (seat count under a per-module
 * lock, the same one permission changes use). The owner manages / views / bills without a license; working as an
 * agent (dialing, replying, editing leads) needs one.
 */
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth";
import { MODULES, TEMPLATES, type ModuleKey } from "@/lib/access/catalog";
import { businessEntitlement, invalidateEntitlement, ownerLicenses, seatHolders } from "@/lib/access/engine";
import { assertBillingAdmin } from "./subscriptions";

export async function licenseSummary(user: SessionUser) {
  const ent = await businessEntitlement(user.businessId);
  const users = await db.user.findMany({ where: { businessId: user.businessId, isActive: true, isSupport: false }, select: { id: true, fullName: true, role: true } });
  const out = [];
  for (const m of MODULES) {
    if (!ent.modules[m].included) continue;
    const holders = await seatHolders(user.businessId, m);
    out.push({ module: m, seats: ent.modules[m].seats, used: holders.length, holders: users.filter((u) => holders.includes(u.id)).map((u) => ({ id: u.id, name: u.fullName, role: u.role })) });
  }
  return { licenses: out, users };
}

/** Give / take a module license. Owner or billing admin (or a manager for their agents via permissions, as before). */
export async function setLicense(actor: SessionUser, input: { userId: string; module: ModuleKey; on: boolean }) {
  await assertBillingAdmin(actor);
  const ent = await businessEntitlement(actor.businessId);
  if (!ent.modules[input.module]?.included) throw new ApiError("המודול לא נרכש", 400, "module_not_purchased");
  const target = await db.user.findFirst({ where: { id: input.userId, businessId: actor.businessId, isActive: true, isSupport: false }, select: { id: true, role: true, permissions: true } });
  if (!target) throw new ApiError("המשתמש לא נמצא", 404, "not_found");
  await db.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`seats:${actor.businessId}:${input.module}`}, 0))`);
    const seats = ent.modules[input.module].seats;
    if (input.on && seats !== null) {
      const holders = (await seatHolders(actor.businessId, input.module, tx)).filter((id) => id !== target.id);
      if (holders.length >= seats) throw new ApiError(`כל ${seats} הרישיונות מוקצים – העבירו רישיון מעובד אחר או הוסיפו רישיון`, 409, "no_seats", { used: holders.length, seats });
    }
    const p = ((target.permissions ?? {}) as Record<string, unknown>);
    if (target.role === "owner") {
      const set = new Set(ownerLicenses(p)); if (input.on) set.add(input.module); else set.delete(input.module);
      await tx.user.update({ where: { id: target.id }, data: { permissions: { ...p, ownerLicenses: [...set] } as Prisma.InputJsonValue } });
    } else {
      const modules = { ...((p.modules ?? {}) as Record<string, { enabled: boolean; actions: string[] }>) };
      const tpl = target.role === "agent" ? TEMPLATES.agent : TEMPLATES.team_manager;
      modules[input.module] = { enabled: input.on, actions: modules[input.module]?.actions?.length ? modules[input.module].actions : [...tpl.actions[input.module]] };
      await tx.user.update({ where: { id: target.id }, data: { permissions: { template: p.template ?? "custom", scope: p.scope ?? (target.role === "agent" ? "own" : "team"), ...p, modules } as Prisma.InputJsonValue } });
    }
  });
  invalidateEntitlement(actor.businessId);
  await audit(actor.businessId, actor.id, "user", target.id, input.on ? "billing.license_assigned" : "billing.license_released", { module: input.module });
  return licenseSummary(actor);
}
