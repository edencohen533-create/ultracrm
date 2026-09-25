import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { emailDesignSchema, renderEmailHtml, renderEmailText } from "@/lib/email/blocks";
import { renderMergeTags, validateMergeTags } from "@/lib/merge-tags";
import { smsMetrics } from "@/lib/sms";

export const dynamic = "force-dynamic";
const SAMPLE = { fullName: "ישראל ישראלי", email: "israel@example.com", phoneE164: "+972500000000", company: "חברה לדוגמה", city: "תל אביב", customFields: {} };

/** Render a draft template with a sample contact (segment count / HTML preview). Nothing is sent. */
export const POST = withAuth(async ({ req, params }) => {
  if (params.channel === "sms") {
    const b = await parseBody(req, z.object({ body: z.string().max(2000), marketing: z.boolean().default(true), inboundSender: z.boolean().default(true) }));
    const problems = validateMergeTags(b.body);
    const r = renderMergeTags(b.body, SAMPLE, { unsubscribe_url: "https://…/u/…" });
    const text = r.text.trim() + (b.marketing ? (b.inboundSender ? "\nלהסרה השיבו הסר" : "\nלהסרה: https://…/u/…") : "");
    return ok({ text, metrics: smsMetrics(text), problems, missing: r.missing });
  }
  if (params.channel === "email") {
    const b = await parseBody(req, z.object({ subject: z.string().max(200), preheader: z.string().max(200).optional(), design: emailDesignSchema }));
    const problems = [...validateMergeTags(b.subject)];
    const html = renderMergeTags(renderEmailHtml(b.design, { preheader: b.preheader }), SAMPLE, { unsubscribe_url: "https://example.com/u/preview" });
    const text = renderMergeTags(renderEmailText(b.design), SAMPLE, { unsubscribe_url: "https://example.com/u/preview" });
    return ok({ subject: renderMergeTags(b.subject, SAMPLE).text, html: html.text, text: text.text, problems, missing: [...new Set([...html.missing, ...text.missing])] });
  }
  throw new ApiError("ערוץ לא תקין", 400, "bad_channel");
}, { module: "messaging" });
