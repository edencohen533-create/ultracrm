"use client";

import { Copy, ExternalLink, FileText, Image as ImageIcon, MapPin, Phone, Reply, Video } from "lucide-react";
import type { ReactNode } from "react";

export interface PreviewButton { type: string; text: string; url?: string | null; phone?: string | null }
export interface PreviewModel { headerFormat?: string | null; headerText?: string | null; body: string; footer?: string | null; buttons?: PreviewButton[]; values?: Record<string, string> }

/** WhatsApp inline formatting: *bold*, _italic_, ~strike~, ```mono```. */
function fmt(text: string): ReactNode[] {
  const out: ReactNode[] = []; const re = /(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|```[^`]+```)/g; let last = 0; let m: RegExpExecArray | null; let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0]; const inner = t.startsWith("```") ? t.slice(3, -3) : t.slice(1, -1);
    out.push(t.startsWith("*") ? <b key={k++}>{inner}</b> : t.startsWith("_") ? <i key={k++}>{inner}</i> : t.startsWith("~") ? <s key={k++}>{inner}</s> : <code key={k++}>{inner}</code>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
const fill = (text: string, values: Record<string, string> = {}, prefix = "") => text.replace(/\{\{(\d+)\}\}/g, (_, n) => values[`${prefix}${n}`] || `{{${n}}}`);

/** A phone-sized WhatsApp chat with the template message as the business sends it. */
export function WhatsAppPreview({ model, businessName = "העסק שלך" }: { model: PreviewModel; businessName?: string }) {
  const f = (model.headerFormat ?? "").toUpperCase();
  const values = model.values ?? {};
  const icon = (b: PreviewButton) => b.type === "URL" ? <ExternalLink size={14} /> : b.type === "PHONE_NUMBER" ? <Phone size={14} /> : b.type === "COPY_CODE" || b.type === "OTP" ? <Copy size={14} /> : <Reply size={14} />;
  const buttons = model.buttons ?? [];
  const shown = buttons.length > 3 ? [...buttons.slice(0, 2), { type: "MORE", text: "כל האפשרויות" }] : buttons;
  return (
    <div className="wa-phone" data-testid="wa-preview">
      <div className="wa-top"><span className="wa-avatar">{businessName.slice(0, 1)}</span><div><b>{businessName}</b><small>חשבון עסקי</small></div></div>
      <div className="wa-chat">
        <div className="wa-bubble">
          {f === "TEXT" && model.headerText && <div className="wa-header-text">{fmt(fill(model.headerText, values, "h"))}</div>}
          {["IMAGE", "VIDEO", "DOCUMENT", "LOCATION"].includes(f) && <div className={`wa-media wa-${f.toLowerCase()}`}>{f === "IMAGE" ? <ImageIcon size={34} /> : f === "VIDEO" ? <Video size={34} /> : f === "DOCUMENT" ? <FileText size={34} /> : <MapPin size={34} />}<span>{f === "IMAGE" ? "תמונה" : f === "VIDEO" ? "וידאו" : f === "DOCUMENT" ? "מסמך" : "מיקום"}</span></div>}
          <div className="wa-body" dir="auto">{fmt(fill(model.body, values)) }</div>
          {model.footer && <div className="wa-footer">{model.footer}</div>}
          <div className="wa-time">12:34</div>
        </div>
        {shown.length > 0 && <div className="wa-buttons">{shown.map((b, i) => <div key={i} className="wa-btn">{b.type === "MORE" ? <><span>☰</span>{b.text}</> : <>{icon(b)}{b.text || (b.type === "COPY_CODE" ? "העתק קוד" : "")}</>}</div>)}</div>}
      </div>
    </div>
  );
}
