import { z } from "zod";
import { templateParameterKeys } from "@/lib/campaigns";

export const submitTemplateSchema = z.object({
  name: z.string().trim().min(1).max(512).regex(/^[a-z0-9_]+$/, "שם התבנית חייב להכיל אותיות קטנות באנגלית, ספרות וקו תחתון"),
  language: z.enum(["he", "en_US", "ar", "ru", "es", "fr"]),
  category: z.enum(["MARKETING", "UTILITY"]),
  body: z.string().trim().min(1).max(1024),
  examples: z.record(z.string(), z.string().trim().min(1).max(200)).default({}),
}).superRefine((value, ctx) => {
  const keys = templateParameterKeys(value.body);
  const matches = [...value.body.matchAll(/\{\{([^}]+)\}\}/g)];
  if (matches.some((m) => !/^[1-9]\d*$/.test(m[1])) || keys.some((k, i) => Number(k) !== i + 1) || /[{}]/.test(value.body.replace(/\{\{\d+\}\}/g, ""))) {
    ctx.addIssue({ code: "custom", path: ["body"], message: "יש להשתמש במשתנים רציפים: {{1}}, {{2}} וכן הלאה" });
  }
  if (keys.some((key) => !value.examples[key]?.trim())) ctx.addIssue({ code: "custom", path: ["examples"], message: "יש למלא דוגמה לכל משתנה לצורך בדיקת Meta" });
});
