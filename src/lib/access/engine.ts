/**
 * THE place that decides what a user may do. Two layers, both required:
 *   1. Business entitlement – what the business has: its pinned package VERSION (+ add-ons, trials, temporary grants,
 *      and the legacy per-business overrides), seats per module, measurable quotas and the access policy
 *      (active / trial / grace / suspended – kept apart from the payment state).
 *   2. User permissions – what the business manager allowed this user: modules, actions and data scope.
 * Effective = entitled ∩ allowed. Unknown actions are denied. The owner always has every action of the modules the
 * business is entitled to (a business can never lock itself out). Everything is read from the database on every
 * request (no re-login needed); the business entitlement is cached for a few seconds per server instance and
 * invalidated on every change made through this module.
 */
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/response";
import type { SessionUser } from "@/lib/auth";
import { ACTIONS, MODULES, MODULE_LABEL, QUOTA_METRICS, TEMPLATES, isPermission, type DataScope, type ModuleKey, type Permission, type QuotaMetric, type UserPermissions } from "./catalog";

// ─── business entitlement ────────────────────────────────────────────────────────────────────────────────────────
export interface ModuleEntitlement { included: boolean; seats: number | null; sources: Array<{ type: string; expiresAt: Date | null; grantId?: string }> }
export interface BusinessEntitlement {
  planName: string | null; planVersion: number | null; planVersionId: string | null; planKey: string | null;
  accessStatus: string; accessUntil: Date | null; billingStatus: string;
  /** Effective suspension: suspended, or a trial / grace period that ended. */
  suspended: boolean;
  modules: Record<ModuleKey, ModuleEntitlement>;
  quotas: Record<QuotaMetric, number | null>;
}
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const cache = new Map<string, { at: number; value: BusinessEntitlement }>();
const CACHE_MS = 5_000;
export function invalidateEntitlement(businessId: string) { cache.delete(businessId); }

export async function businessEntitlement(businessId: string, now = new Date()): Promise<BusinessEntitlement> {
  const hit = cache.get(businessId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const b = await db.business.findUnique({ where: { id: businessId }, select: { modules: true, accessStatus: true, accessUntil: true, billingStatus: true, plan: { select: { key: true, name: true, modules: true, quotas: true } }, planVersion: { select: { id: true, version: true, name: true, modules: true, quotas: true } } } });
  if (!b) throw new ApiError("עסק לא נמצא", 404, "not_found");
  const grants = await db.entitlementGrant.findMany({ where: { businessId, revokedAt: null, startsAt: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } });
  const modules = computeModules(b.planVersion ? b.planVersion.modules : null, b.plan?.modules ?? null, b.modules, grants);
  const q = rec(b.planVersion ? b.planVersion.quotas : b.plan?.quotas);
  const quotas = Object.fromEntries(QUOTA_METRICS.map((k) => [k, typeof q[k] === "number" ? (q[k] as number) : null])) as Record<QuotaMetric, number | null>;
  const expired = (b.accessStatus === "trial" || b.accessStatus === "grace") && b.accessUntil !== null && b.accessUntil <= now;
  const value: BusinessEntitlement = {
    planName: b.planVersion?.name ?? b.plan?.name ?? null, planVersion: b.planVersion?.version ?? null, planVersionId: b.planVersion?.id ?? null, planKey: b.plan?.key ?? null,
    accessStatus: b.accessStatus, accessUntil: b.accessUntil, billingStatus: b.billingStatus, suspended: b.accessStatus === "suspended" || b.accessStatus === "cancelled" || expired, modules, quotas,
  };
  cache.set(businessId, { at: Date.now(), value });
  return value;
}

/**
 * Modules of a business from its parts – shared by the live entitlement and the "what if" impact preview.
 * versionModules = pinned package version ({ m: { included, seats } }); without one, the legacy plan JSON (or every
 * module) applies, adjusted by the legacy overrides (false removes, true adds) – overrides are ignored once a
 * version is pinned (the migration turned any extra module into an add-on grant). Grants (add-on / trial / temporary) add the module and seats.
 */
export function computeModules(versionModules: unknown | null, legacyPlanModules: unknown | null, overridesRaw: unknown, grants: Array<{ id: string; module: string; kind: string; seats: number | null; expiresAt: Date | null }>) {
  const modules = {} as Record<ModuleKey, ModuleEntitlement>;
  const overrides = rec(overridesRaw);
  for (const m of MODULES) {
    const e: ModuleEntitlement = { included: false, seats: 0, sources: [] };
    if (versionModules !== null) {
      const pm = rec(rec(versionModules)[m]);
      if (pm.included === true) { e.included = true; e.seats = typeof pm.seats === "number" ? pm.seats : null; e.sources.push({ type: "plan", expiresAt: null }); }
    } else {
      const legacy = rec(legacyPlanModules);
      const on = typeof legacy[m] === "boolean" ? legacy[m] === true : true;
      if (on) { e.included = true; e.seats = null; e.sources.push({ type: "legacy", expiresAt: null }); }
    }
    // Legacy per-business overrides apply only without a pinned package (a package is changed by versions + grants).
    if (versionModules === null) {
      if (overrides[m] === false) { e.included = false; e.sources = []; }
      else if (overrides[m] === true && !e.included) { e.included = true; e.seats = null; e.sources.push({ type: "override", expiresAt: null }); }
    }
    for (const g of grants.filter((x) => x.module === m)) {
      const wasIncluded = e.included;
      e.included = true;
      e.seats = g.seats === null || e.seats === null ? null : (wasIncluded ? e.seats : 0) + g.seats;
      e.sources.push({ type: g.kind, expiresAt: g.expiresAt, grantId: g.id });
    }
    if (!e.included) e.seats = 0;
    modules[m] = e;
  }
  return modules;
}

// ─── user permissions ────────────────────────────────────────────────────────────────────────────────────────────
interface UserRow { id: string; role: string; teamId: string | null; permissions: unknown; isActive: boolean }
async function businessPermissionSettings(businessId: string) {
  const b = await db.business.findUnique({ where: { id: businessId }, select: { settings: true } });
  const p = rec(rec(b?.settings).permissions);
  return { managerScope: p.managerScope === "team" ? "team" as const : "business" as const, agentTransfer: p.agentTransfer === "all" || p.agentTransfer === "selected" ? p.agentTransfer : "none", agentTransferUserIds: Array.isArray(p.agentTransferUserIds) ? p.agentTransferUserIds as string[] : [] };
}

export function parsePermissions(raw: unknown): UserPermissions | null {
  const r = rec(raw); if (!Object.keys(r).length) return null;
  const scope: DataScope = r.scope === "business" || r.scope === "team" ? r.scope : "own";
  const modules: UserPermissions["modules"] = {};
  for (const m of MODULES) {
    const g = rec(rec(r.modules)[m]);
    if (!Object.keys(g).length) continue;
    modules[m] = { enabled: g.enabled === true, actions: (Array.isArray(g.actions) ? g.actions : []).filter((a): a is string => typeof a === "string" && a in ACTIONS[m]) };
  }
  return { template: (typeof r.template === "string" ? r.template : "custom") as UserPermissions["template"], scope, modules };
}

/**
 * The permissions of a user as stored, or – for users not migrated yet – derived from their role exactly as the
 * product behaved before (so nobody gains or loses access by the upgrade). `derived` marks them for review.
 */
export async function userPermissions(businessId: string, u: UserRow, ent?: BusinessEntitlement): Promise<UserPermissions & { derived: boolean }> {
  const stored = parsePermissions(u.permissions);
  if (stored) return { ...stored, derived: false };
  const e = ent ?? await businessEntitlement(businessId);
  const s = await businessPermissionSettings(businessId);
  const key = u.role === "agent" ? "agent" : u.role === "manager" && s.managerScope === "team" ? "team_manager" : "business_manager";
  const t = TEMPLATES[key];
  const modules: UserPermissions["modules"] = {};
  for (const m of MODULES) if (e.modules[m].included) {
    // Agents never had the campaign screens (the menu showed them to managers only) → no SMS / email seat.
    if (u.role === "agent" && (m === "sms" || m === "email")) continue;
    // Managers could do everything in every module before (only their data scope differed).
    const actions = u.role === "agent" ? [...t.actions[m]] : Object.keys(ACTIONS[m]).filter((a) => !(m === "whatsapp" && a === "connect" && key === "team_manager"));
    // Connecting / disconnecting the business's WhatsApp account: owner and business-level managers by default; a
    // team-scoped manager only when granted explicitly.
    // Before this feature every user could work every module of the business; lead transfer followed הרשאות.
    if (m === "crm" && u.role === "agent" && (s.agentTransfer === "all" || (s.agentTransfer === "selected" && s.agentTransferUserIds.includes(u.id)))) actions.push("transfer");
    modules[m] = { enabled: true, actions: [...new Set(actions)] };
  }
  return { template: key, scope: t.scope, modules, derived: true };
}

// ─── effective access ────────────────────────────────────────────────────────────────────────────────────────────
export interface EffectiveModule { state: "active" | "not_assigned" | "not_in_package" | "suspended"; actions: string[] }
export interface EffectiveAccess { userId: string; businessId: string; isOwner: boolean; scope: DataScope; template: string; derived: boolean; suspended: boolean; modules: Record<ModuleKey, EffectiveModule> }

export async function effectiveAccess(businessId: string, userId: string): Promise<EffectiveAccess> {
  const u = await db.user.findFirst({ where: { id: userId, businessId }, select: { id: true, role: true, teamId: true, permissions: true, isActive: true, isSupport: true } });
  if (!u || (!u.isActive && !u.isSupport)) throw new ApiError("לא מחובר", 401, "unauthorized");
  const ent = await businessEntitlement(businessId);
  const perms = await userPermissions(businessId, u, ent);
  const isOwner = u.role === "owner";
  const modules = {} as Record<ModuleKey, EffectiveModule>;
  for (const m of MODULES) {
    if (!ent.modules[m].included) { modules[m] = { state: "not_in_package", actions: [] }; continue; }
    if (ent.suspended) { modules[m] = { state: "suspended", actions: [] }; continue; }
    if (isOwner) { modules[m] = { state: "active", actions: Object.keys(ACTIONS[m]) }; continue; }
    // Platform support: every purchased module, view actions only (mutations are refused in requireUser anyway).
    if (u.isSupport) { modules[m] = { state: "active", actions: Object.keys(ACTIONS[m]).filter((a) => /view|read|list|report/i.test(a)) }; continue; }
    const g = perms.modules[m];
    modules[m] = g?.enabled ? { state: "active", actions: g.actions.filter((a) => a in ACTIONS[m]) } : { state: "not_assigned", actions: [] };
  }
  return { userId, businessId, isOwner, scope: isOwner || u.isSupport ? "business" : perms.scope, template: isOwner ? "owner" : perms.template, derived: perms.derived, suspended: ent.suspended, modules };
}

export function can(a: EffectiveAccess, p: Permission) { const [m, act] = p.split(".") as [ModuleKey, string]; return a.modules[m].state === "active" && a.modules[m].actions.includes(act); }
export function canUseModule(a: EffectiveAccess, m: ModuleKey) { return a.modules[m].state === "active"; }

const DENY: Record<EffectiveModule["state"], [string, string]> = {
  suspended: ["הגישה של העסק מושעית – פנה למנהל הפלטפורמה", "business_suspended"],
  not_in_package: ["המודול אינו כלול בחבילה של העסק", "module_not_purchased"],
  not_assigned: ["המודול לא הוקצה לך – פנה למנהל העסק", "module_not_assigned"],
  active: ["", ""],
};

/** Throw 403 unless the user may use the module (and, when given, perform the action). Default = deny. */
export async function assertAccess(user: Pick<SessionUser, "businessId" | "id">, need: ModuleKey | Permission | Array<ModuleKey | Permission>) {
  const a = await effectiveAccess(user.businessId, user.id);
  const list = Array.isArray(need) ? need : [need];
  // An array means "any of" (e.g. a screen shared by WhatsApp / SMS / email).
  let last: ApiError | null = null;
  for (const n of list) {
    if (n.includes(".")) {
      if (!isPermission(n)) { last = new ApiError("פעולה לא מוכרת", 403, "action_denied"); continue; }
      const [m, act] = n.split(".") as [ModuleKey, string];
      const st = a.modules[m].state;
      if (st !== "active") { last = new ApiError(`${MODULE_LABEL[m]}: ${DENY[st][0]}`, 403, DENY[st][1], { module: m }); continue; }
      if (!a.modules[m].actions.includes(act)) { last = new ApiError(`אין לך הרשאה לפעולה "${(ACTIONS[m] as Record<string, string>)[act]}" ב${MODULE_LABEL[m]}`, 403, "action_denied", { permission: n }); continue; }
      return a;
    }
    const m = n as ModuleKey; const st = a.modules[m].state;
    if (st === "active") return a;
    last = new ApiError(`${MODULE_LABEL[m]}: ${DENY[st][0]}`, 403, DENY[st][1], { module: m });
  }
  throw last ?? new ApiError("אין הרשאה", 403, "action_denied");
}

/** Business-level check for background work (no user): the module is in the package and the business is not suspended. */
export async function businessCanUse(businessId: string, m: ModuleKey) {
  const e = await businessEntitlement(businessId);
  return !e.suspended && e.modules[m].included;
}

// ─── seats ───────────────────────────────────────────────────────────────────────────────────────────────────────
/** Active users that currently hold a seat of the module (owners included – they always have access). */
export async function seatHolders(businessId: string, m: ModuleKey, tx: Prisma.TransactionClient | typeof db = db) {
  const users = await tx.user.findMany({ where: { businessId, isActive: true }, select: { id: true, role: true, teamId: true, permissions: true, isActive: true } });
  const ent = await businessEntitlement(businessId);
  const out: string[] = [];
  for (const u of users) {
    if (u.role === "owner") { if (ent.modules[m].included) out.push(u.id); continue; }
    const p = await userPermissions(businessId, u, ent);
    if (p.modules[m]?.enabled) out.push(u.id);
  }
  return out;
}
export async function seatSummary(businessId: string) {
  const ent = await businessEntitlement(businessId);
  const out = {} as Record<ModuleKey, { included: boolean; seats: number | null; used: number; free: number | null }>;
  for (const m of MODULES) { const used = ent.modules[m].included ? (await seatHolders(businessId, m)).length : 0; const seats = ent.modules[m].seats; out[m] = { included: ent.modules[m].included, seats, used, free: seats === null ? null : Math.max(0, seats - used) }; }
  return out;
}
