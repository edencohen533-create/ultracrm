/**
 * Email block editor document + renderer (HTML and plain text).
 * Table-based, inline-styled, RTL by default, 600px max width, mobile friendly.
 * Marketing emails always end with an unsubscribe link ({{unsubscribe_url}} is
 * substituted per recipient at send time).
 */
import { z } from "zod";
import { escapeHtml } from "@/lib/merge-tags";

const url = z.string().trim().max(2000).refine((v) => /^(https?:\/\/|mailto:|tel:|\{\{)/.test(v), "קישור חייב להתחיל ב-https:// (או mailto: / tel:)");
const text = z.string().max(5000);

export const blockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), text: text.min(1), level: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1), align: z.enum(["start", "center", "end"]).default("start") }),
  z.object({ type: z.literal("text"), text: text.min(1), align: z.enum(["start", "center", "end"]).default("start") }),
  z.object({ type: z.literal("image"), src: url, alt: z.string().max(200).default(""), href: url.optional(), width: z.number().int().min(50).max(600).optional() }),
  z.object({ type: z.literal("button"), text: z.string().trim().min(1).max(80), href: url, color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#4f46e5"), align: z.enum(["start", "center", "end"]).default("center") }),
  z.object({ type: z.literal("link"), text: z.string().trim().min(1).max(200), href: url }),
  z.object({ type: z.literal("divider") }),
  z.object({ type: z.literal("footer"), text: text.default(""), unsubscribeText: z.string().trim().min(1).max(120).default("להסרה מרשימת התפוצה לחצו כאן") }),
]);
export type EmailBlock = z.infer<typeof blockSchema>;

export const emailDesignSchema = z.object({
  version: z.literal(1).default(1),
  settings: z.object({
    direction: z.enum(["rtl", "ltr"]).default("rtl"),
    backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#f4f4f7"),
    contentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#ffffff"),
    textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#1f2937"),
    fontFamily: z.string().max(200).default("Arial, Helvetica, sans-serif"),
  }).default({ direction: "rtl", backgroundColor: "#f4f4f7", contentColor: "#ffffff", textColor: "#1f2937", fontFamily: "Arial, Helvetica, sans-serif" }),
  blocks: z.array(blockSchema).min(1).max(60),
});
export type EmailDesign = z.infer<typeof emailDesignSchema>;

export const defaultEmailDesign = (): EmailDesign => emailDesignSchema.parse({
  blocks: [
    { type: "heading", text: "שלום {{first_name|לקוח יקר}}," },
    { type: "text", text: "כאן כותבים את תוכן ההודעה. ניתן להשתמש במשתנים כמו {{name}} או {{company|}}." },
    { type: "button", text: "לפרטים נוספים", href: "https://example.com" },
    { type: "footer", text: "שם העסק · כתובת · טלפון" },
  ],
});

const alignCss = (a: "start" | "center" | "end", dir: "rtl" | "ltr") => a === "center" ? "center" : (a === "start") === (dir === "rtl") ? "right" : "left";

/** Minimal inline markup: **bold**, line breaks. Everything else is escaped. */
function inline(t: string) {
  return escapeHtml(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>");
}

export function renderEmailHtml(design: EmailDesign, opts: { preheader?: string | null } = {}): string {
  const s = design.settings;
  const dir = s.direction;
  const base = `font-family:${s.fontFamily};color:${s.textColor};font-size:16px;line-height:1.6;`;
  const parts: string[] = [];
  let hasUnsubscribe = false;
  for (const b of design.blocks) {
    switch (b.type) {
      case "heading": { const size = b.level === 1 ? 26 : b.level === 2 ? 22 : 18; parts.push(`<tr><td style="${base}padding:8px 24px;text-align:${alignCss(b.align, dir)};font-size:${size}px;font-weight:700;line-height:1.3;">${inline(b.text)}</td></tr>`); break; }
      case "text": parts.push(`<tr><td style="${base}padding:8px 24px;text-align:${alignCss(b.align, dir)};">${inline(b.text)}</td></tr>`); break;
      case "image": { const img = `<img src="${escapeHtml(b.src)}" alt="${escapeHtml(b.alt)}" width="${b.width ?? 552}" style="display:block;max-width:100%;height:auto;border:0;margin:0 auto;">`; parts.push(`<tr><td style="padding:8px 24px;text-align:center;">${b.href ? `<a href="${escapeHtml(b.href)}" target="_blank">${img}</a>` : img}</td></tr>`); break; }
      case "button": parts.push(`<tr><td style="padding:12px 24px;text-align:${alignCss(b.align, dir)};"><a href="${escapeHtml(b.href)}" target="_blank" style="${base}display:inline-block;background:${b.color};color:#ffffff;text-decoration:none;font-weight:700;padding:12px 28px;border-radius:8px;">${escapeHtml(b.text)}</a></td></tr>`); break;
      case "link": parts.push(`<tr><td style="${base}padding:4px 24px;"><a href="${escapeHtml(b.href)}" target="_blank" style="color:#4f46e5;">${escapeHtml(b.text)}</a></td></tr>`); break;
      case "divider": parts.push(`<tr><td style="padding:8px 24px;"><hr style="border:0;border-top:1px solid #e5e7eb;margin:0;"></td></tr>`); break;
      case "footer": hasUnsubscribe = true; parts.push(`<tr><td style="${base}padding:16px 24px;font-size:12px;color:#6b7280;text-align:center;">${b.text ? `${inline(b.text)}<br>` : ""}<a href="{{unsubscribe_url}}" style="color:#6b7280;text-decoration:underline;">${escapeHtml(b.unsubscribeText)}</a></td></tr>`); break;
    }
  }
  if (!hasUnsubscribe) parts.push(`<tr><td style="${base}padding:16px 24px;font-size:12px;color:#6b7280;text-align:center;"><a href="{{unsubscribe_url}}" style="color:#6b7280;text-decoration:underline;">להסרה מרשימת התפוצה לחצו כאן</a></td></tr>`);
  const preheader = opts.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(opts.preheader)}${"&#847;&zwnj;&nbsp;".repeat(30)}</div>` : "";
  return `<!DOCTYPE html>
<html lang="${dir === "rtl" ? "he" : "en"}" dir="${dir}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title></title>
<style>@media only screen and (max-width:620px){.container{width:100%!important}td{padding-left:16px!important;padding-right:16px!important}}</style></head>
<body style="margin:0;padding:0;background:${s.backgroundColor};" dir="${dir}">${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${s.backgroundColor};"><tr><td align="center" style="padding:24px 8px;">
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:${s.contentColor};border-radius:12px;" dir="${dir}">
${parts.join("\n")}
</table></td></tr></table>
</body></html>`;
}

export function renderEmailText(design: EmailDesign): string {
  const lines: string[] = [];
  let hasUnsubscribe = false;
  for (const b of design.blocks) {
    switch (b.type) {
      case "heading": lines.push(b.text, ""); break;
      case "text": lines.push(b.text.replace(/\*\*(.+?)\*\*/g, "$1"), ""); break;
      case "image": if (b.alt) lines.push(`[${b.alt}]${b.href ? ` ${b.href}` : ""}`, ""); break;
      case "button": lines.push(`${b.text}: ${b.href}`, ""); break;
      case "link": lines.push(`${b.text}: ${b.href}`); break;
      case "divider": lines.push("----------", ""); break;
      case "footer": hasUnsubscribe = true; lines.push("", b.text, `${b.unsubscribeText}: {{unsubscribe_url}}`); break;
    }
  }
  if (!hasUnsubscribe) lines.push("", "להסרה מרשימת התפוצה: {{unsubscribe_url}}");
  return lines.join("\n").trim();
}

/** All merge-taggable text of a design (for validation). */
export function designText(design: EmailDesign) {
  return design.blocks.map((b) => ("text" in b ? b.text : "") + ("href" in b && b.href ? ` ${b.href}` : "")).join("\n");
}
