/**
 * Changing entitlements and permissions (server only). Every change: permission-checked, bounded by the package,
 * seats reserved under a per-module lock (parallel requests cannot oversell), and written to AccessAuditLog
 * (who, which business / user, before → after, when). Platform operations run outside the tenant scope on purpose
 * (the platform admin is not a member of the business) – they are reachable only through requirePlatformAdmin.
 */
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { visibleUserIds, type SessionUser } from "@/lib/auth";
import { withoutBusiness } from "@/lib/tenant";
import { ACTIONS, MODULES, QUOTA_METRICS, TEMPLATES, type DataScope, type ModuleKey, type TemplateKey, type UserPermissions } from "./catalog";
import { businessEntitlement, computeModules, effectiveAccess, invalidateEntitlement, parsePermissions, seatHolders, seatSummary, userPermissions, type ModuleEntitlement } from "./engine";

const SCOPE_RANK: Record<DataScope, number> = { own: 1, team: 2, business: 3 };

export async function accessAudit(input: { businessId: string | null; actorAccountId: string | null; targetUserId?: string | null; action: string; before?: unknown; after?: unknown }) {
  await withoutBusiness(() => db.accessAuditLog.create({ data: { businessId: input.businessId, actorAccountId: input.actorAccountId, targetUserId: input.targetUserId ?? null, action: input.action, before: (input.before ?? undefined) as Prisma.InputJsonValue | undefined, after: (input.after ?? undefined) as Prisma.InputJsonValue | undefined } }));
}

// ─── business manager: the permission matrix ─────────────────────────────────────────────────────────────────────
export const permissionsInputSchema = z.object({
  template: z.enum(["business_manager", "team_manager", "agent", "custom"]).default("custom"),
  scope: z.enum(["own", "team", "business"]),
  modules: z.partialRecord(z.enum(MODULES as [ModuleKey, ...ModuleKey[]]), z.object({ enabled: z.boolean(), actions: z.array(z.string()).max(20) })),
});

/** Users of the business (within the manager's scope) with their effective access, seats and the package state. */
export async function permissionMatrix(actor: SessionUser) {
  if (actor.role === "agent") throw new ApiError("ניהול הרשאות זמין למנהלים", 403, "forbidden");
  const ids = await visibleUserIds(actor);
  const users = await db.user.findMany({ where: { businessId: actor.businessId, ...(ids ? { id: { in: ids } } : {}) }, orderBy: [{ isActive: "desc" }, { fullName: "asc" }], select: { id: true, fullName: true, email: true, role: true, isActive: true, teamId: true, permissions: true } });
  const ent = await businessEntitlement(actor.businessId);
  const rows = [];
  for (const u of users) {
    const eff = u.isActive ? await effectiveAccess(actor.businessId, u.id) : null;
    const perms = await userPermissions(actor.businessId, u, ent);
    rows.push({ id: u.id, fullName: u.fullName, email: u.email, role: u.role, isActive: u.isActive, derived: perms.derived, template: u.role === "owner" ? "owner" : perms.template, scope: u.role === "owner" ? "business" : perms.scope, permissions: perms.modules, effective: eff?.modules ?? null });
  }
  const actorAccess = await effectiveAccess(actor.businessId, actor.id);
  return {
    users: rows, seats: await seatSummary(actor.businessId),
    entitlement: { planName: ent.planName, planVersion: ent.planVersion, accessStatus: ent.accessStatus, accessUntil: ent.accessUntil, billingStatus: ent.billingStatus, suspended: ent.suspended, modules: ent.modules, quotas: ent.quotas },
    actor: { id: actor.id, role: actor.role, scope: actorAccess.scope, modules: actorAccess.modules },
  };
}

/**
 * Set a user's module access. Rules: only owners / managers; nobody edits their own permissions or an owner;
 * managers only edit agents inside their data scope and never grant more than they have (actions and scope);
 * only modules in the package; seats are checked under a lock so concurrent assignments cannot exceed them.
 */
export async function setUserPermissions(actor: SessionUser, targetUserId: string, raw: unknown, opts: { platform?: boolean } = {}) {
  const input = permissionsInputSchema.parse(raw);
  const businessId = actor.businessId;
  const target = await db.user.findFirst({ where: { id: targetUserId, businessId }, select: { id: true, role: true, teamId: true, permissions: true, isActive: true, fullName: true } });
  if (!target) throw new ApiError("המשתמש לא נמצא בעסק", 404, "not_found");
  if (!opts.platform) {
    if (actor.role === "agent") throw new ApiError("אין הרשאה לנהל הרשאות", 403, "forbidden");
    if (target.id === actor.id) throw new ApiError("אי אפשר לשנות את ההרשאות של עצמך", 403, "self_escalation");
    if (target.role === "owner") throw new ApiError("לבעלי העסק יש תמיד גישה מלאה למודולים שבחבילה", 400, "owner_fixed");
    if (actor.role === "manager") {
      if (target.role !== "agent") throw new ApiError("מנהל יכול לנהל הרשאות של נציגים בלבד", 403, "forbidden");
      const ids = await visibleUserIds(actor);
      if (ids && !ids.includes(target.id)) throw new ApiError("המשתמש אינו בתחום שלך", 403, "forbidden");
    }
  } else if (target.role === "owner") throw new ApiError("לבעלי העסק יש תמיד גישה מלאה למודולים שבחבילה", 400, "owner_fixed");
  const ent = await businessEntitlement(businessId);
  const actorAccess = opts.platform ? null : await effectiveAccess(businessId, actor.id);
  if (actorAccess && actor.role !== "owner" && SCOPE_RANK[input.scope] > SCOPE_RANK[actorAccess.scope]) throw new ApiError("אי אפשר להעניק היקף נתונים רחב יותר משלך", 403, "self_escalation");
  const modules: UserPermissions["modules"] = {};
  for (const m of MODULES) {
    const g = input.modules[m]; if (!g) continue;
    const actions = [...new Set(g.actions)].filter((a) => a in ACTIONS[m]);
    if (g.actions.some((a) => !(a in ACTIONS[m]))) throw new ApiError(`פעולה לא נתמכת במודול ${m}`, 400, "unknown_action");
    if (g.enabled && !ent.modules[m].included) throw new ApiError("אי אפשר להקצות מודול שאינו כלול בחבילה של העסק", 400, "module_not_purchased", { module: m });
    if (actorAccess && actor.role !== "owner") {
      const mine = actorAccess.modules[m];
      const extra = actions.filter((a) => !(mine.state === "active" && mine.actions.includes(a)));
      if (g.enabled && extra.length) throw new ApiError("אי אפשר להעניק פעולות שאין לך בעצמך", 403, "self_escalation", { module: m, actions: extra });
    }
    modules[m] = { enabled: g.enabled, actions };
  }
  const next: UserPermissions = { template: input.template as TemplateKey | "custom", scope: input.scope, modules };
  const before = await userPermissions(businessId, target, ent);
  const newlyEnabled = MODULES.filter((m) => modules[m]?.enabled && !before.modules[m]?.enabled);
  await db.$transaction(async (tx) => {
    // Seats: one lock per business + module, then count the holders (excluding this user) – no overselling in parallel.
    for (const m of newlyEnabled.sort()) {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`seats:${businessId}:${m}`}, 0))`);
      const seats = ent.modules[m].seats;
      if (seats === null) continue;
      const holders = (await seatHolders(businessId, m, tx)).filter((id) => id !== target.id);
      if (holders.length >= seats) throw new ApiError(`אין מושבים פנויים במודול (${holders.length}/${seats})`, 409, "no_seats", { module: m, used: holders.length, seats });
    }
    await tx.user.update({ where: { id: target.id }, data: { permissions: next as unknown as Prisma.InputJsonValue } });
  });
  await accessAudit({ businessId, actorAccountId: actor.accountId, targetUserId: target.id, action: opts.platform ? "platform.user_permissions_set" : "user_permissions_set", before: { template: before.template, scope: before.scope, modules: before.modules, derived: before.derived }, after: next });
  return next;
}

/** Store the role-derived permissions of users not migrated yet (explicit review; also run before any package change). */
export async function materializeDerived(businessId: string, actorAccountId: string | null) {
  const users = await db.user.findMany({ where: { businessId }, select: { id: true, role: true, teamId: true, permissions: true, isActive: true } });
  const ent = await businessEntitlement(businessId);
  let n = 0;
  for (const u of users) {
    if (parsePermissions(u.permissions) || u.role === "owner") continue;
    const p = await userPermissions(businessId, u, ent);
    await db.user.update({ where: { id: u.id }, data: { permissions: { template: p.template, scope: p.scope, modules: p.modules } as unknown as Prisma.InputJsonValue } });
    n++;
  }
  if (n) await accessAudit({ businessId, actorAccountId, action: "permissions_materialized", after: { users: n } });
  return n;
}

// ─── platform admin ──────────────────────────────────────────────────────────────────────────────────────────────
export async function requirePlatformAdmin(user: SessionUser) {
  const a = await withoutBusiness(() => db.account.findUnique({ where: { id: user.accountId }, select: { isPlatformAdmin: true, isActive: true } }));
  if (!a?.isActive || !a.isPlatformAdmin) throw new ApiError("זמין למנהל הפלטפורמה בלבד", 403, "forbidden");
}

export const planSpecSchema = z.object({
  name: z.string().trim().min(1).max(80), description: z.string().max(500).nullable().optional(),
  modules: z.partialRecord(z.enum(MODULES as [ModuleKey, ...ModuleKey[]]), z.object({ included: z.boolean(), seats: z.number().int().min(0).max(100000).nullable() })),
  // Only metrics the product measures and enforces (src/lib/modules.ts consumeQuota / currentUsage).
  quotas: z.partialRecord(z.enum(QUOTA_METRICS as unknown as [string, ...string[]]), z.number().int().min(0).max(100_000_000).nullable()).default({}),
});

export async function listPlans() {
  return withoutBusiness(async () => {
    const plans = await db.plan.findMany({ orderBy: { createdAt: "asc" }, include: { versions: { orderBy: { version: "desc" }, include: { _count: { select: { businesses: true } } } } } });
    return plans.map((p) => ({ id: p.id, key: p.key, name: p.name, description: p.description, currentVersion: p.currentVersion, isArchived: p.isArchived, versions: p.versions.map((v) => ({ id: v.id, version: v.version, name: v.name, modules: v.modules, quotas: v.quotas, createdAt: v.createdAt, businesses: v._count.businesses })) }));
  });
}

/** New package, or a NEW VERSION of an existing one – businesses stay on their version until explicitly moved. */
export async function savePlan(actor: SessionUser, raw: unknown, planId?: string) {
  const spec = planSpecSchema.parse(raw);
  return withoutBusiness(async () => {
    const r = await db.$transaction(async (tx) => {
      const plan = planId ? await tx.plan.findUnique({ where: { id: planId } }) : await tx.plan.create({ data: { key: `pkg_${Date.now().toString(36)}`, name: spec.name, description: spec.description ?? null, currentVersion: 0, modules: {}, quotas: {} } });
      if (!plan) throw new ApiError("החבילה לא נמצאה", 404, "not_found");
      const version = plan.currentVersion + 1;
      const v = await tx.planVersion.create({ data: { planId: plan.id, version, name: spec.name, description: spec.description ?? null, modules: spec.modules as Prisma.InputJsonValue, quotas: spec.quotas as Prisma.InputJsonValue, createdById: actor.accountId } });
      await tx.plan.update({ where: { id: plan.id }, data: { currentVersion: version, name: spec.name, description: spec.description ?? null } });
      return { plan, version: v };
    });
    await accessAudit({ businessId: null, actorAccountId: actor.accountId, action: planId ? "plan.version_created" : "plan.created", after: { planId: r.plan.id, version: r.version.version, spec } });
    return r.version;
  });
}

export async function listBusinesses() {
  return withoutBusiness(async () => {
    const rows = await db.business.findMany({ orderBy: { createdAt: "desc" }, select: { id: true, name: true, isActive: true, accessStatus: true, accessUntil: true, billingStatus: true, planVersion: { select: { id: true, version: true, name: true, planId: true } }, plan: { select: { name: true } }, _count: { select: { users: true } } } });
    const out = [];
    for (const b of rows) {
      const e = await businessEntitlement(b.id);
      out.push({ ...b, users: b._count.users, needsPackage: !b.planVersion, modules: Object.fromEntries(MODULES.map((m) => [m, { included: e.modules[m].included, seats: e.modules[m].seats, sources: e.modules[m].sources.map((s) => s.type) }])) });
    }
    return out;
  });
}

// ─── impact of an entitlement change ─────────────────────────────────────────────────────────────────────────────
export interface Impact {
  modulesRemoved: ModuleKey[];
  usersLosing: Record<string, Array<{ id: string; fullName: string }>>;
  seatOverflow: Record<string, { seats: number; holders: Array<{ id: string; fullName: string }> }>;
  campaigns: Array<{ id: string; name: string; channel: string; status: string }>;
  journeys: Array<{ id: string; name: string }>;
  inboxAutomations: number; serviceAgent: boolean; dialerSessions: number; dialLists: number;
}
type GrantSpec = { module: ModuleKey; kind: string; seats: number | null; expiresAt: Date | null };
type Target = { planVersionId?: string | null; revokeGrantId?: string; addGrant?: GrantSpec; revokeGrantIds?: string[]; addGrants?: GrantSpec[]; legacyModules?: Partial<Record<ModuleKey, boolean>> };

async function futureModules(businessId: string, t: Target) {
  const b = await db.business.findUniqueOrThrow({ where: { id: businessId }, select: { modules: true, planVersionId: true, plan: { select: { modules: true } }, planVersion: { select: { modules: true } } } });
  const pvId = t.planVersionId !== undefined ? t.planVersionId : b.planVersionId;
  const pv = pvId ? (pvId === b.planVersionId ? b.planVersion : await db.planVersion.findUnique({ where: { id: pvId }, select: { modules: true } })) : null;
  if (pvId && !pv) throw new ApiError("גרסת החבילה לא נמצאה", 404, "not_found");
  const now = new Date();
  let grants = await db.entitlementGrant.findMany({ where: { businessId, revokedAt: null, startsAt: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, select: { id: true, module: true, kind: true, seats: true, expiresAt: true } });
  if (t.revokeGrantId) grants = grants.filter((g) => g.id !== t.revokeGrantId);
  if (t.revokeGrantIds?.length) grants = grants.filter((g) => !t.revokeGrantIds!.includes(g.id));
  if (t.addGrant) grants.push({ id: "new", ...t.addGrant });
  for (const [i, g] of (t.addGrants ?? []).entries()) grants.push({ id: `new${i}`, ...g });
  const overrides = { ...((b.modules ?? {}) as Record<string, unknown>), ...(t.legacyModules ?? {}) };
  return computeModules(pv ? pv.modules : null, b.plan?.modules ?? null, overrides, grants);
}

export async function computeImpact(businessId: string, t: Target): Promise<{ impact: Impact; after: Record<ModuleKey, ModuleEntitlement> }> {
  return withoutBusiness(async () => {
    const now = await businessEntitlement(businessId);
    const after = await futureModules(businessId, t);
    const users = await db.user.findMany({ where: { businessId, isActive: true }, select: { id: true, fullName: true } });
    const name = new Map(users.map((u) => [u.id, u.fullName]));
    const impact: Impact = { modulesRemoved: [], usersLosing: {}, seatOverflow: {}, campaigns: [], journeys: [], inboxAutomations: 0, serviceAgent: false, dialerSessions: 0, dialLists: 0 };
    for (const m of MODULES) {
      const holders = now.modules[m].included ? await seatHolders(businessId, m) : [];
      if (now.modules[m].included && !after[m].included) {
        impact.modulesRemoved.push(m);
        impact.usersLosing[m] = holders.map((id) => ({ id, fullName: name.get(id) ?? "" }));
      } else if (after[m].included && after[m].seats !== null && holders.length > after[m].seats) {
        impact.seatOverflow[m] = { seats: after[m].seats, holders: holders.map((id) => ({ id, fullName: name.get(id) ?? "" })) };
      }
    }
    const lostChannels = impact.modulesRemoved.filter((m) => m === "whatsapp" || m === "sms" || m === "email");
    if (lostChannels.length) {
      impact.campaigns = (await db.campaign.findMany({ where: { businessId, channel: { in: lostChannels as never }, status: { in: ["SCHEDULED", "RUNNING", "PAUSED"] } }, select: { id: true, name: true, channel: true, status: true } })).map((c) => ({ ...c, channel: String(c.channel), status: String(c.status) }));
      impact.journeys = await db.marketingSequence.findMany({ where: { businessId, isActive: true, steps: { some: { action: "send", channel: { in: lostChannels as never } } } }, select: { id: true, name: true } });
    }
    if (impact.modulesRemoved.includes("whatsapp")) {
      impact.inboxAutomations = await db.automationRule.count({ where: { businessId, isActive: true } });
      const s = await db.business.findUnique({ where: { id: businessId }, select: { settings: true } });
      impact.serviceAgent = Boolean((s?.settings as { ai?: { service?: { enabled?: boolean } } } | null)?.ai?.service?.enabled);
    }
    if (impact.modulesRemoved.includes("telephony")) {
      impact.dialerSessions = await db.dialerSession.count({ where: { businessId, status: { in: ["active", "paused"] } } });
      impact.dialLists = await db.dialList.count({ where: { businessId, isActive: true, archivedAt: null } });
    }
    return { impact, after };
  });
}

/**
 * Apply an entitlement change after the preview. Seat overflow needs an explicit list of users who KEEP the module
 * (never chosen arbitrarily). Removed modules are closed for users (enabled=false – actions kept for the record) so
 * buying them again never re-opens access by itself. Nothing is deleted; running campaigns / journeys stop safely in
 * the workers (re-checked before every send); live calls are not cut.
 */
export async function applyEntitlementChange(actor: SessionUser, businessId: string, t: Target, keep: Record<string, string[]> = {}, keepLegacy: string[] = []) {
  await requirePlatformAdmin(actor);
  const { impact, after } = await computeImpact(businessId, t);
  for (const [m, o] of Object.entries(impact.seatOverflow)) {
    const k = keep[m];
    if (!k) throw new ApiError(`חריגה ממכסת המושבים (${o.holders.length}/${o.seats}) – יש לבחור מי נשאר עם גישה`, 409, "seat_choice_required", { module: m, ...o });
    if (k.length > o.seats || k.some((id) => !o.holders.some((h) => h.id === id))) throw new ApiError("בחירת המשתמשים אינה תואמת את המושבים", 400, "seat_choice_invalid", { module: m });
  }
  return withoutBusiness(async () => {
    const before = await businessEntitlement(businessId);
    await materializeDerived(businessId, actor.accountId); // later package changes never grant modules by themselves
    await db.$transaction(async (tx) => {
      if (t.planVersionId !== undefined) {
        const pv = t.planVersionId ? await tx.planVersion.findUnique({ where: { id: t.planVersionId }, select: { planId: true } }) : null;
        await tx.business.update({ where: { id: businessId }, data: { planVersionId: t.planVersionId, planId: pv?.planId ?? null } });
        // Legacy overrides stop applying once a package is pinned: keep any module they added as an explicit add-on.
        if (t.planVersionId && !before.planVersionId) {
          const legacy = await tx.business.findUniqueOrThrow({ where: { id: businessId }, select: { modules: true } });
          const pvMods = (await tx.planVersion.findUniqueOrThrow({ where: { id: t.planVersionId }, select: { modules: true } })).modules as Record<string, { included?: boolean }>;
          for (const [m, v] of Object.entries((legacy.modules ?? {}) as Record<string, unknown>)) if (v === true && !pvMods[m]?.included && (MODULES as string[]).includes(m) && keepLegacy.includes(m)) await tx.entitlementGrant.create({ data: { businessId, module: m, kind: "addon", seats: null, note: "הומר מהתאמה ידנית קודמת", createdById: actor.accountId } });
          await tx.business.update({ where: { id: businessId }, data: { modules: {} } });
        }
      }
      // Bump the business row: cached entitlements on every server instance see the change on their next read.
      await tx.business.update({ where: { id: businessId }, data: { updatedAt: new Date() } });
      if (t.revokeGrantId) await tx.entitlementGrant.updateMany({ where: { id: t.revokeGrantId, businessId, revokedAt: null }, data: { revokedAt: new Date() } });
      if (t.revokeGrantIds?.length) await tx.entitlementGrant.updateMany({ where: { id: { in: t.revokeGrantIds }, businessId, revokedAt: null }, data: { revokedAt: new Date() } });
      if (t.addGrant) await tx.entitlementGrant.create({ data: { businessId, module: t.addGrant.module, kind: t.addGrant.kind, seats: t.addGrant.seats, expiresAt: t.addGrant.expiresAt, createdById: actor.accountId } });
      for (const g of t.addGrants ?? []) await tx.entitlementGrant.create({ data: { businessId, module: g.module, kind: g.kind, seats: g.seats, expiresAt: g.expiresAt, createdById: actor.accountId } });
      if (t.legacyModules && Object.keys(t.legacyModules).length) {
        const cur = await tx.business.findUniqueOrThrow({ where: { id: businessId }, select: { modules: true } });
        await tx.business.update({ where: { id: businessId }, data: { modules: { ...((cur.modules ?? {}) as Record<string, unknown>), ...t.legacyModules } as Prisma.InputJsonValue } });
      }
      const users = await tx.user.findMany({ where: { businessId, role: { not: "owner" } }, select: { id: true, permissions: true } });
      for (const u of users) {
        const p = parsePermissions(u.permissions); if (!p) continue;
        let changed = false;
        for (const m of MODULES) {
          const g = p.modules[m]; if (!g?.enabled) continue;
          const drop = !after[m].included || (impact.seatOverflow[m] && !keep[m]?.includes(u.id));
          if (drop) { p.modules[m] = { ...g, enabled: false }; changed = true; }
        }
        if (changed) await tx.user.update({ where: { id: u.id }, data: { permissions: p as unknown as Prisma.InputJsonValue } });
      }
    });
    invalidateEntitlement(businessId);
    const now = await businessEntitlement(businessId);
    await accessAudit({ businessId, actorAccountId: actor.accountId, action: "entitlement_changed", before: { planVersion: before.planVersionId, modules: before.modules }, after: { planVersion: now.planVersionId, modules: now.modules, target: t, keep, impact } });
    return { impact, entitlement: now };
  });
}

export const ACCESS_STATUSES = ["setup", "trial", "active", "grace", "suspended", "cancelled"] as const;
export type AccessStatus = (typeof ACCESS_STATUSES)[number];
/** What changing the status does, BEFORE it is done (shown with the confirmation). Data is never deleted. */
export async function statusImpact(businessId: string, status: AccessStatus) {
  return withoutBusiness(async () => {
    const [campaigns, journeys, dialerSessions, dialLists, stores, webhooks, users, settings] = await Promise.all([
      db.campaign.count({ where: { businessId, status: { in: ["SCHEDULED", "RUNNING"] } } }),
      db.marketingSequence.count({ where: { businessId, isActive: true } }),
      db.dialerSession.count({ where: { businessId, status: { in: ["active", "paused"] } } }),
      db.dialList.count({ where: { businessId, isActive: true, archivedAt: null } }),
      db.storeConnection.count({ where: { businessId, isActive: true } }),
      db.webhookEndpoint.count({ where: { businessId, isActive: true } }),
      db.user.count({ where: { businessId, isActive: true } }),
      db.business.findUnique({ where: { id: businessId }, select: { settings: true } }),
    ]);
    const stops = status === "suspended" || status === "cancelled";
    return { status, stops, users, campaigns, journeys, dialerSessions, dialLists, stores, outgoingWebhooks: webhooks, serviceAgent: Boolean((settings?.settings as { ai?: { service?: { enabled?: boolean } } } | null)?.ai?.service?.enabled),
      effects: stops ? [
        "משתמשי העסק לא יוכלו לבצע פעולות במודולים (הכניסה תציג שהגישה מושעית)",
        "קמפיינים, מסעות, אוטומציות, סוכן השירות וחיוג אוטומטי נעצרים לפני כל שליחה / חיוג",
        "Webhooks יוצאים ללקוח נעצרים; אירועים נכנסים (WhatsApp, חנות, טלפוניה) ממשיכים להישמר – שום מידע לא הולך לאיבוד",
        "שום נתון לא נמחק; חידוש מחזיר את הפעילות מאותה נקודה",
      ] : ["הגישה והפעילות לפי החבילה והמודולים", ...(status === "trial" || status === "grace" ? ["בתאריך הסיום העסק יושעה אוטומטית (ללא מחיקה)"] : [])] };
  });
}

export async function setAccessStatus(actor: SessionUser, businessId: string, status: AccessStatus, until: Date | null, opts: { reason?: string; confirmName?: string } = {}) {
  await requirePlatformAdmin(actor);
  if ((status === "trial" || status === "grace") && !until) throw new ApiError("לניסיון / תקופת חסד יש לקבוע תאריך סיום", 400, "validation");
  return withoutBusiness(async () => {
    const b = await db.business.findUnique({ where: { id: businessId }, select: { name: true, accessStatus: true, accessUntil: true } });
    if (!b) throw new ApiError("עסק לא נמצא", 404, "not_found");
    if (status === "suspended" || status === "cancelled") {
      if (!opts.reason?.trim()) throw new ApiError("להשעיה / ביטול יש לכתוב סיבה", 400, "reason_required");
      if ((opts.confirmName ?? "").trim() !== b.name.trim()) throw new ApiError("לאישור יש להקליד את שם העסק בדיוק", 400, "confirm_name");
    }
    await db.business.update({ where: { id: businessId }, data: { accessStatus: status, accessUntil: status === "trial" || status === "grace" ? until : null, statusReason: opts.reason?.trim() || null, cancelledAt: status === "cancelled" ? new Date() : null } });
    invalidateEntitlement(businessId);
    await accessAudit({ businessId, actorAccountId: actor.accountId, action: "access_status_changed", before: { accessStatus: b.accessStatus, accessUntil: b.accessUntil }, after: { accessStatus: status, accessUntil: until, reason: opts.reason ?? null } });
  });
}

export async function businessDetail(businessId: string) {
  return withoutBusiness(async () => {
    const b = await db.business.findUnique({ where: { id: businessId }, select: { id: true, name: true, accessStatus: true, accessUntil: true, billingStatus: true, planVersionId: true } });
    if (!b) throw new ApiError("עסק לא נמצא", 404, "not_found");
    const ent = await businessEntitlement(businessId);
    const grants = await db.entitlementGrant.findMany({ where: { businessId }, orderBy: { createdAt: "desc" } });
    const users = await db.user.findMany({ where: { businessId, isSupport: false }, orderBy: [{ isActive: "desc" }, { fullName: "asc" }], select: { id: true, fullName: true, email: true, role: true, isActive: true, teamId: true, permissions: true } });
    const rows = [];
    for (const u of users) { const p = await userPermissions(businessId, u, ent); rows.push({ id: u.id, fullName: u.fullName, email: u.email, role: u.role, isActive: u.isActive, derived: p.derived, template: u.role === "owner" ? "owner" : p.template, scope: p.scope, permissions: p.modules, effective: u.isActive ? (await effectiveAccess(businessId, u.id)).modules : null }); }
    const audit = await db.accessAuditLog.findMany({ where: { businessId }, orderBy: { createdAt: "desc" }, take: 50 });
    return { business: b, entitlement: ent, seats: await seatSummary(businessId), grants, users: rows, audit, templates: TEMPLATES };
  });
}


// ─── per-module switches (settings → plan, platform admin) ──────────────────────────────────────────────────────
export type ModuleSwitchBlock = { module: ModuleKey; reason: string };
/**
 * Turn "module on / off" choices into a precise entitlement change on the business's real sources:
 *  • on  – with a pinned package version: an add-on grant (no expiry, no seat cap); without one (legacy): the override;
 *  • off – revoke the module's grants; without a pinned version also the override. A module that comes from the
 *    package version itself (or a paid subscription) can't be switched off here – it is the package, changed by
 *    moving to another version (billing) – reported as blocked, never silently skipped.
 */
export async function compileModuleSwitches(businessId: string, desired: Partial<Record<ModuleKey, boolean>>) {
  return withoutBusiness(async () => {
    const e = await businessEntitlement(businessId);
    const pinned = Boolean(e.planVersionId) || Boolean(e.subscription);
    const t: Target = { addGrants: [], revokeGrantIds: [], legacyModules: {} };
    const blocked: ModuleSwitchBlock[] = [];
    const changes: Array<{ module: ModuleKey; to: boolean }> = [];
    for (const m of MODULES) {
      const want = desired[m]; const cur = e.modules[m];
      if (want === undefined || want === cur.included) continue;
      if (e.subscription) { blocked.push({ module: m, reason: "המודולים נקבעים לפי המנוי המשולם – שינוי דרך חיוב ושימוש" }); continue; }
      if (want) {
        if (pinned) t.addGrants!.push({ module: m, kind: "addon", seats: null, expiresAt: null }); else t.legacyModules![m] = true;
      } else {
        if (cur.sources.some((s) => s.type === "plan")) { blocked.push({ module: m, reason: `המודול כלול בגרסת החבילה${e.planName ? ` "${e.planName}"` : ""} – להסרה יש להעביר את העסק לגרסת חבילה אחרת (ניהול הפלטפורמה)` }); continue; }
        for (const s of cur.sources) if ("grantId" in s && s.grantId) t.revokeGrantIds!.push(s.grantId as string);
        if (!pinned) t.legacyModules![m] = false;
      }
      changes.push({ module: m, to: want });
    }
    return { target: t, blocked, changes, entitlement: e };
  });
}
