import { z } from "zod";
import type { ReportParams } from "./report";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const DAYS = [7, 14, 30, 60, 90] as const;
export const reportQuerySchema = z.object({
  from: day, to: day,
  mode: z.enum(["cohort", "activity"]).default("cohort"),
  level: z.enum(["campaign", "adset", "ad"]).default("campaign"),
  window: z.coerce.number().refine((n) => (DAYS as readonly number[]).includes(n)).default(30),
  maturity: z.coerce.number().refine((n) => (DAYS as readonly number[]).includes(n)).default(30),
  accounts: z.string().max(2000).optional(),
  agentId: z.string().max(64).optional(),
  campaignId: z.string().regex(/^\d{3,30}$/).optional(),
  adsetId: z.string().regex(/^\d{3,30}$/).optional(),
  basis: z.enum(["gross", "ex_tax_shipping"]).default("gross"),
  compare: z.enum(["previous", "none", "custom"]).default("previous"),
  compareFrom: day.optional(), compareTo: day.optional(),
  key: z.string().max(64).optional(),
});
export function toParams(q: z.infer<typeof reportQuerySchema>): ReportParams {
  return { from: q.from, to: q.to, mode: q.mode, level: q.level, windowDays: q.window, maturityDays: q.maturity, accountIds: q.accounts ? q.accounts.split(",").filter(Boolean) : undefined, agentId: q.agentId || null, campaignId: q.campaignId ?? null, adsetId: q.adsetId ?? null, revenueBasis: q.basis, compare: q.compare, compareFrom: q.compareFrom ?? null, compareTo: q.compareTo ?? null };
}
