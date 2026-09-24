import { z } from "zod";

const text = z.string().trim().min(1).max(200);
const leafSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("tag"), operator: z.enum(["is", "is_not"]), value: text }).strict(),
  z.object({ field: z.literal("source"), operator: z.enum(["equals", "contains"]), value: text }).strict(),
  z.object({ field: z.literal("custom"), operator: z.enum(["equals", "contains"]), key: text, value: text }).strict(),
  z.object({ field: z.literal("agent"), operator: z.literal("is"), value: text }).strict(),
  /** CRM owner of the contact (null = no owner). */
  z.object({ field: z.literal("owner"), operator: z.enum(["is", "is_not"]), value: text.nullable() }).strict(),
  /** Has an open/any lead in this status. */
  z.object({ field: z.literal("leadStatus"), operator: z.enum(["is", "is_not"]), value: z.enum(["new", "contacted", "qualified", "unqualified", "converted", "none"]) }).strict(),
  z.object({ field: z.literal("consent"), operator: z.literal("is"), value: z.enum(["OPTED_IN", "OPTED_OUT", "UNKNOWN"]) }).strict(),
  z.object({ field: z.literal("blocked"), operator: z.literal("is"), value: z.boolean() }).strict(),
  z.object({ field: z.literal("marketingEligible"), operator: z.literal("is"), value: z.boolean() }).strict(),
  z.object({ field: z.enum(["lastMessage", "lastInbound", "lastOutbound"]), operator: z.enum(["before", "after", "never"]), value: z.iso.datetime({ offset: true }).optional() }).strict().refine((rule) => rule.operator === "never" || !!rule.value, "נדרש תאריך להשוואה"),
  z.object({ field: z.literal("campaign"), operator: z.literal("is"), value: text, result: z.enum(["ANY", "QUEUED", "PROCESSING", "SENT", "FAILED", "SKIPPED", "UNKNOWN", "DELIVERED", "READ", "REPLIED", "NOT_DELIVERED"]) }).strict(),
]);
export type AudienceRule = z.infer<typeof leafSchema>;
export type AudienceNode = AudienceRule | { operator: "AND" | "OR"; conditions: AudienceNode[] };
// Bounded schema avoids recursively parsing unbounded user-controlled nesting.
let bounded: z.ZodType<AudienceNode> = leafSchema;
for (let level = 0; level < 3; level++) bounded = z.union([leafSchema, z.object({ operator: z.enum(["AND", "OR"]), conditions: z.array(bounded).min(1).max(20) }).strict()]);
export const audienceSchema = bounded.superRefine((node, context) => {
  let count = 0;
  function visit(item: AudienceNode) { count++; if ("conditions" in item) item.conditions.forEach(visit); }
  visit(node);
  if (count > 50) context.addIssue({ code: "custom", message: "מותר לשמור עד 50 תנאים וקבוצות בקהל" });
});
export const MAX_AUDIENCE_SIZE = 10000;
export function audienceRules(node: AudienceNode): AudienceRule[] {
  return "conditions" in node ? node.conditions.flatMap(audienceRules) : [node];
}
export const defaultAudience = (): AudienceNode => ({ operator: "AND", conditions: [{ field: "consent", operator: "is", value: "OPTED_IN" }] });
