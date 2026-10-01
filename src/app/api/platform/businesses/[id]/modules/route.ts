import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { MODULES, type ModuleKey } from "@/lib/access/catalog";
import { applyEntitlementChange, compileModuleSwitches, computeImpact, requirePlatformAdmin } from "@/lib/access/manage";

export const dynamic = "force-dynamic";
const schema = z.object({
  modules: z.partialRecord(z.enum(MODULES as [ModuleKey, ...ModuleKey[]]), z.boolean()),
  /** false = preview only (what changes, what's blocked, who / what is affected); true = apply. */
  confirm: z.boolean().default(false),
  keep: z.record(z.string(), z.array(z.string())).default({}),
});

/**
 * Settings → package → "ניהול מודולים" (platform admin): switch modules on / off for a business. Preview first –
 * nothing changes until `confirm`. Blocked switches (a module that IS the package version / a paid subscription)
 * are reported, never applied silently. Access only – no charge or credit is created here.
 */
export const POST = withAuth(async ({ req, user, params }) => {
  await requirePlatformAdmin(user);
  const b = await parseBody(req, schema);
  const { target, blocked, changes } = await compileModuleSwitches(params.id, b.modules);
  const impact = changes.length ? (await computeImpact(params.id, target)).impact : null;
  if (!b.confirm) return ok({ changes, blocked, impact });
  if (blocked.length) throw new ApiError(blocked.map((x) => x.reason).join(" · "), 409, "module_switch_blocked", { blocked });
  if (!changes.length) throw new ApiError("לא נבחר שינוי", 400, "no_change");
  const r = await applyEntitlementChange(user, params.id, target, b.keep);
  return ok({ changes, impact: r.impact, entitlement: r.entitlement });
});
