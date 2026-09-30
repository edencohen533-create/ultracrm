import { z } from "zod";
import { LEAD_STATUSES } from "@/lib/crm/labels";

const dir = z.enum(["in", "out", "both", "none"]);
/**
 * Connection settings (mapping, selection, directions, source of truth, freshness, deletion, write-back).
 * Defaults = the documented source-of-truth rules: contact details and handling agent come from the external CRM;
 * calls / messages / their results from UltraCRM; statuses and follow-ups only as mapped and in the chosen direction;
 * a block is enforced here at once and sent out – an ordinary external update never lifts it.
 */
export const crmSettingsSchema = z.object({
  records: z.object({ contacts: z.boolean().default(true), leads: z.boolean().default(true) }).default({ contacts: true, leads: true }),
  userMap: z.record(z.string().max(120), z.string().max(64)).default({}),
  statusMap: z.record(z.string().max(120), z.enum(LEAD_STATUSES)).default({}),
  statusOutMap: z.partialRecord(z.enum(LEAD_STATUSES), z.string().max(120)).default({}),
  fieldMap: z.object({ product: z.string().max(120).optional(), source: z.string().max(120).optional(), campaign: z.string().max(120).optional(), list: z.string().max(120).optional() }).default({}),
  directions: z.object({ status: dir.default("in"), followUp: dir.default("in") }).default({ status: "in", followUp: "in" }),
  /** Which records enter work here (empty = none). Syncing a contact never dials or messages anyone by itself. */
  selection: z.object({ statuses: z.array(z.string().max(120)).max(50).default([]), lists: z.array(z.string().max(120)).max(50).default([]), owners: z.array(z.string().max(120)).max(200).default([]), teams: z.array(z.string().max(120)).max(50).default([]) }).default({ statuses: [], lists: [], owners: [], teams: [] }),
  /** Separate, explicit step: put selected leads into this dial list. */
  queue: z.object({ enabled: z.boolean().default(false), listId: z.string().max(64).nullable().default(null) }).default({ enabled: false, listId: null }),
  writeback: z.object({ calls: z.boolean().default(true), aiSummary: z.boolean().default(true), detailsLink: z.boolean().default(true), followUpTasks: z.boolean().default(true), status: z.boolean().default(false), whatsappSummary: z.boolean().default(false), blocks: z.boolean().default(true) }).default({ calls: true, aiSummary: true, detailsLink: true, followUpTasks: true, status: false, whatsappSummary: false, blocks: true }),
  /** The external CRM decides assignment: automatic dialing pauses when its data is older than this. */
  ownerAuthority: z.enum(["external", "local"]).default("external"),
  freshnessMinutes: z.number().int().min(5).max(7 * 24 * 60).default(24 * 60),
  pollMinutes: z.number().int().min(5).max(24 * 60).default(15),
  deletionPolicy: z.enum(["stop_activity", "close_lead"]).default("stop_activity"),
});
export type CrmSettings = z.infer<typeof crmSettingsSchema>;
export const parseSettings = (raw: unknown): CrmSettings => crmSettingsSchema.parse(raw ?? {});
