import { z } from "zod";
import { ConsentStatus } from "@/generated/prisma/client";

export const contactSchema = z.object({
  name: z.string().trim().min(1, "נא להזין שם").max(200),
  phone: z.string().min(1, "נא להזין מספר טלפון"),
  email: z.union([z.email("כתובת אימייל לא תקינה"), z.literal("")]).optional(),
  source: z.string().max(200).optional(),
  isBlocked: z.boolean().optional(),
  consentEvidence: z.string().trim().max(1000).optional(),
  consentSource: z.string().trim().max(200).optional(),
  consentStatus: z.enum(ConsentStatus),
  tagIds: z.array(z.string().min(1)).max(100).refine((ids) => new Set(ids).size === ids.length, "תגיות כפולות"),
  customFields: z.array(z.object({ key: z.string().trim().min(1).max(100), value: z.string().max(2000) })).max(50).refine((fields) => new Set(fields.map((field) => field.key)).size === fields.length, "שמות שדות חייבים להיות ייחודיים").optional(),
});

export type ContactInput = z.infer<typeof contactSchema>;
