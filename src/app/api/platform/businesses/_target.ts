import { z } from "zod";
import { MODULES, type ModuleKey } from "@/lib/access/catalog";

/** What an entitlement change is: move to a package version, add an add-on / trial / temporary grant, or revoke one. */
export const targetSchema = z.object({
  planVersionId: z.string().nullable().optional(),
  revokeGrantId: z.string().optional(),
  addGrant: z.object({ module: z.enum(MODULES as [ModuleKey, ...ModuleKey[]]), kind: z.enum(["addon", "trial", "temporary"]), seats: z.number().int().min(0).max(100000).nullable(), expiresAt: z.iso.datetime().nullable() }).optional(),
}).refine((t) => t.planVersionId !== undefined || t.revokeGrantId || t.addGrant, "לא נבחר שינוי")
  .refine((t) => !t.addGrant || t.addGrant.kind === "addon" || t.addGrant.expiresAt, "לניסיון / הרשאה זמנית יש לקבוע תאריך תפוגה");
export const toTarget = (t: z.infer<typeof targetSchema>) => ({ ...t, addGrant: t.addGrant ? { ...t.addGrant, expiresAt: t.addGrant.expiresAt ? new Date(t.addGrant.expiresAt) : null } : undefined });
