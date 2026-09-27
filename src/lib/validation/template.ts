import { z } from "zod";
import { templateParameterKeys } from "@/lib/campaigns";

/** Languages offered in the template builder (Meta language codes). */
export const TEMPLATE_LANGUAGES: Record<string, string> = { he: "עברית", en: "אנגלית", en_US: "אנגלית (ארה\"ב)", en_GB: "אנגלית (בריטניה)", ar: "ערבית", ru: "רוסית", es: "ספרדית", fr: "צרפתית", de: "גרמנית", it: "איטלקית", pt_BR: "פורטוגזית (ברזיל)", tr: "טורקית", am: "אמהרית", uk: "אוקראינית" };

const button = z.discriminatedUnion("type", [
  z.object({ type: z.literal("QUICK_REPLY"), text: z.string().trim().min(1).max(25) }),
  z.object({ type: z.literal("URL"), text: z.string().trim().min(1).max(25), url: z.string().trim().min(8).max(2000), example: z.string().trim().max(2000).optional() }),
  z.object({ type: z.literal("PHONE_NUMBER"), text: z.string().trim().min(1).max(25), phone: z.string().trim().regex(/^\+?\d{7,20}$/, "מספר טלפון בפורמט בינלאומי, למשל +972501234567") }),
  z.object({ type: z.literal("COPY_CODE"), example: z.string().trim().min(1).max(15) }),
]);
export type TemplateButtonInput = z.infer<typeof button>;

/**
 * Everything Meta's template builder offers: category, language, header (none / text with one variable / image /
 * video / document / location), body with numbered variables and samples, footer, buttons (quick replies, links
 * with an optional dynamic suffix, phone number, copy code) and the authentication (OTP) template.
 */
export const submitTemplateSchema = z.object({
  name: z.string().trim().min(1).max(512).regex(/^[a-z0-9_]+$/, "שם התבנית חייב להכיל אותיות קטנות באנגלית, ספרות וקו תחתון"),
  language: z.string().refine((l) => l in TEMPLATE_LANGUAGES, "שפה לא נתמכת"),
  category: z.enum(["MARKETING", "UTILITY", "AUTHENTICATION"]),
  header: z.object({
    format: z.enum(["NONE", "TEXT", "IMAGE", "VIDEO", "DOCUMENT", "LOCATION"]),
    text: z.string().trim().max(60).optional(),
    example: z.string().trim().max(60).optional(),
    /** Sample media (public https link) – uploaded to Meta for review. */
    mediaUrl: z.string().trim().max(2000).optional(),
  }).default({ format: "NONE" }),
  body: z.string().trim().max(1024).default(""),
  examples: z.record(z.string(), z.string().trim().min(1).max(200)).default({}),
  footer: z.string().trim().max(60).optional(),
  buttons: z.array(button).max(10).default([]),
  auth: z.object({ addSecurityRecommendation: z.boolean().default(true), codeExpirationMinutes: z.number().int().min(1).max(90).optional(), otpType: z.enum(["COPY_CODE", "ONE_TAP"]).default("COPY_CODE") }).optional(),
}).superRefine((v, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
  if (v.category === "AUTHENTICATION") return; // Meta fixes the body/buttons of OTP templates
  if (!v.body) issue("body", "יש לכתוב את גוף ההודעה");
  const keys = templateParameterKeys(v.body);
  const matches = [...v.body.matchAll(/\{\{([^}]+)\}\}/g)];
  if (matches.some((m) => !/^[1-9]\d*$/.test(m[1])) || keys.some((k, i) => Number(k) !== i + 1) || /[{}]/.test(v.body.replace(/\{\{\d+\}\}/g, ""))) issue("body", "יש להשתמש במשתנים רציפים: {{1}}, {{2}} וכן הלאה");
  if (keys.some((key) => !v.examples[key]?.trim())) issue("examples", "יש למלא דוגמה לכל משתנה לצורך בדיקת Meta");
  if (/^\s*\{\{\d+\}\}|\{\{\d+\}\}\s*$/.test(v.body)) issue("body", "Meta לא מאשרת גוף שמתחיל או מסתיים במשתנה");
  if (v.header.format === "TEXT") {
    if (!v.header.text) issue("header", "יש לכתוב את טקסט הכותרת");
    const hk = templateParameterKeys(v.header.text ?? "");
    if (hk.length > 1 || (hk.length === 1 && hk[0] !== "1")) issue("header", "בכותרת מותר משתנה אחד בלבד: {{1}}");
    if (hk.length === 1 && !v.header.example) issue("header", "יש למלא דוגמה למשתנה בכותרת");
  }
  if (["IMAGE", "VIDEO", "DOCUMENT"].includes(v.header.format) && !v.header.mediaUrl) issue("header", "יש לצרף קובץ לדוגמה (קישור https) – Meta בודקת אותו");
  const count = (t: string) => v.buttons.filter((b) => b.type === t).length;
  if (count("URL") > 2) issue("buttons", "עד 2 כפתורי קישור");
  if (count("PHONE_NUMBER") > 1) issue("buttons", "כפתור טלפון אחד בלבד");
  if (count("COPY_CODE") > 1) issue("buttons", "כפתור העתקת קוד אחד בלבד");
  for (const b of v.buttons) if (b.type === "URL") {
    if (!/^https?:\/\//.test(b.url)) issue("buttons", "כתובת הכפתור חייבת להתחיל ב-https://");
    if (/\{\{1\}\}$/.test(b.url) && !b.example) issue("buttons", "לכפתור קישור דינמי נדרשת כתובת לדוגמה");
    if (/\{\{/.test(b.url.replace(/\{\{1\}\}$/, ""))) issue("buttons", "משתנה בקישור מותר רק בסופו: …/{{1}}");
  }
  // Meta: quick replies must be grouped together (not interleaved with call-to-action buttons).
  const kinds = v.buttons.map((b) => (b.type === "QUICK_REPLY" ? "q" : "c")).join("");
  if (/q+c+q|c+q+c/.test(kinds)) issue("buttons", "יש לקבץ את כפתורי התגובה המהירה יחד (לפני או אחרי כפתורי הפעולה)");
});
export type SubmitTemplateInput = z.infer<typeof submitTemplateSchema>;
