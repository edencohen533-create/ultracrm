import { z } from "zod";

const text = z.string().trim().min(1).max(200);
const productTerms = z.array(z.string().trim().min(2).max(80)).max(10);
const days = z.number().int().min(1).max(3650);
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
  /** Bought (or not) – from real purchases: store orders as sold, phone sales with items, paid carts. `products` are
   *  name fragments (any matches; empty = any product); `withinDays` empty = ever. */
  z.object({ field: z.literal("purchase"), operator: z.enum(["did", "did_not"]), products: productTerms, withinDays: days.optional() }).strict(),
  /** Bought one of `first.products` within `first.withinDays`, and LATER (at least `minDaysAfter`, at most
   *  `maxDaysAfter` days after that purchase) bought `then.products` – or any product other than the first. */
  z.object({ field: z.literal("purchaseSequence"),
    first: z.object({ products: productTerms.refine((p) => p.length > 0, "יש לציין מוצר ראשון"), withinDays: days }).strict(),
    then: z.object({ products: productTerms, otherThanFirst: z.boolean(), minDaysAfter: z.number().int().min(0).max(3650), maxDaysAfter: z.number().int().min(0).max(3650).optional() }).strict()
      .refine((t) => t.otherThanFirst || t.products.length > 0, "יש לציין מוצר שני או 'מוצר אחר'").refine((t) => t.maxDaysAfter === undefined || t.maxDaysAfter >= t.minDaysAfter, "טווח הימים אינו תקין"),
  }).strict(),
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
export { defaultAudience } from "./audience-defaults";
