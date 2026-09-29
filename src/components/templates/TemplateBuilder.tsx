"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Button, Input, Modal, Select, Textarea } from "@/components/ui";
import { templateParameterKeys } from "@/lib/campaign-shared";
import { TEMPLATE_LANGUAGES } from "@/lib/template-languages";
import type { TemplateButtonInput } from "@/lib/validation/template";
import { WhatsAppPreview } from "./WhatsAppPreview";
import { TemplateImageUpload, type UploadedImage } from "./TemplateImageUpload";
import { useT } from "@/components/i18n/LangProvider";

type Category = "MARKETING" | "UTILITY" | "AUTHENTICATION";
type HeaderFormat = "NONE" | "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION";
const CATEGORIES: Array<[Category, string, string, string, string]> = [
  ["MARKETING", "שיווק", "מבצעים, הצעות, עדכוני מוצר, הזמנה לאירוע", "Marketing", "Promotions, offers, product updates, event invitations"],
  ["UTILITY", "שירות (Utility)", "אישור הזמנה, תזכורת לפגישה, עדכון סטטוס, פולואפ", "Utility", "Order confirmation, appointment reminder, status update, follow-up"],
  ["AUTHENTICATION", "אימות", "קוד חד-פעמי (OTP) להתחברות או לאימות", "Authentication", "One-time passcode (OTP) for login or verification"],
];
const HEADERS: Array<[HeaderFormat, string, string]> = [["NONE", "ללא", "None"], ["TEXT", "טקסט", "Text"], ["IMAGE", "תמונה", "Image"], ["VIDEO", "וידאו", "Video"], ["DOCUMENT", "מסמך", "Document"], ["LOCATION", "מיקום", "Location"]];
const BUTTON_TYPES: Array<[TemplateButtonInput["type"], string, string]> = [["QUICK_REPLY", "תגובה מהירה", "Quick reply"], ["URL", "מעבר לאתר", "Visit website"], ["PHONE_NUMBER", "חיוג למספר", "Call phone number"], ["COPY_CODE", "העתקת קוד הנחה", "Copy offer code"]];
const blankButton = (type: TemplateButtonInput["type"]): TemplateButtonInput => type === "QUICK_REPLY" ? { type, text: "" } : type === "URL" ? { type, text: "", url: "https://", example: "" } : type === "PHONE_NUMBER" ? { type, text: "", phone: "+972" } : { type, example: "" };

/** Meta's template builder – every option (category, language, header types, body with samples, footer, buttons, OTP). */
export function TemplateBuilder({ businessName, onClose }: { businessName?: string; onClose: () => void }) {
  const t = useT();
  const router = useRouter();
  const [name, setName] = useState("");
  const [language, setLanguage] = useState("he");
  const [category, setCategory] = useState<Category>("UTILITY");
  const [headerFormat, setHeaderFormat] = useState<HeaderFormat>("NONE");
  const [headerText, setHeaderText] = useState("");
  const [headerExample, setHeaderExample] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [image, setImage] = useState<UploadedImage | null>(null);
  const [body, setBody] = useState("");
  const [examples, setExamples] = useState<Record<string, string>>({});
  const [footer, setFooter] = useState("");
  const [buttons, setButtons] = useState<TemplateButtonInput[]>([]);
  const [auth, setAuth] = useState({ addSecurityRecommendation: true, codeExpirationMinutes: 10, otpType: "COPY_CODE" as "COPY_CODE" | "ONE_TAP" });
  const [busy, setBusy] = useState(false);
  const keys = useMemo(() => templateParameterKeys(body), [body]);
  const headerHasVar = /\{\{1\}\}/.test(headerText);
  const isAuth = category === "AUTHENTICATION";
  const addVar = () => setBody((b) => `${b}{{${keys.length + 1}}}`);
  const wrap = (ch: string) => setBody((b) => `${b}${ch}${t("טקסט", "text")}${ch}`);
  const setBtn = (i: number, patch: Partial<TemplateButtonInput>) => setButtons((l) => l.map((b, j) => (j === i ? ({ ...b, ...patch } as TemplateButtonInput) : b)));
  const count = (type: string) => buttons.filter((b) => b.type === type).length;
  const canAdd = (type: TemplateButtonInput["type"]) => buttons.length < 10 && (type === "URL" ? count("URL") < 2 : type === "PHONE_NUMBER" || type === "COPY_CODE" ? count(type) < 1 : true);

  const preview = isAuth
    ? { body: t(`*123456* הוא קוד האימות שלך.${auth.addSecurityRecommendation ? " מטעמי אבטחה, אין לשתף את הקוד." : ""}`, `*123456* is your verification code.${auth.addSecurityRecommendation ? " For your security, do not share this code." : ""}`), footer: auth.codeExpirationMinutes ? t(`תוקף הקוד: ${auth.codeExpirationMinutes} דקות.`, `This code expires in ${auth.codeExpirationMinutes} minutes.`) : null, buttons: [{ type: "OTP", text: auth.otpType === "ONE_TAP" ? t("מילוי אוטומטי", "Autofill") : t("העתק קוד", "Copy code") }] }
    : { headerFormat: headerFormat === "NONE" ? null : headerFormat, headerText, headerImageUrl: headerFormat === "IMAGE" ? image?.previewUrl ?? null : null, body: body || t("תוכן ההודעה יופיע כאן", "Your message content will appear here"), footer, values: { ...examples, h1: headerExample }, buttons: buttons.map((b) => ({ type: b.type, text: b.type === "COPY_CODE" ? t("העתק קוד", "Copy code") : b.text })) };

  async function submit() {
    setBusy(true);
    try {
      const payload = { name, language, category, header: isAuth ? { format: "NONE" } : { format: headerFormat, ...(headerFormat === "TEXT" ? { text: headerText, ...(headerHasVar ? { example: headerExample } : {}) } : {}), ...(headerFormat === "IMAGE" && image ? { mediaAssetId: image.id } : ["IMAGE", "VIDEO", "DOCUMENT"].includes(headerFormat) ? { mediaUrl } : {}) }, body: isAuth ? "" : body, examples: Object.fromEntries(keys.map((k) => [k, examples[k] ?? ""])), footer: isAuth ? undefined : footer || undefined, buttons: isAuth ? [] : buttons, ...(isAuth ? { auth } : {}) };
      const res = await fetch("/api/templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.error || t("ההגשה נכשלה", "Submission failed")); router.refresh(); return; }
      toast.success(t("התבנית הוגשה ל-Meta. הסטטוס יתעדכן לאחר האישור (סנכרון)", "Template submitted to Meta. The status will update after review (sync)")); onClose(); router.refresh();
    } catch { toast.error(t("לא ניתן לאמת את ההגשה. יש לסנכרן לפני ניסיון נוסף", "Couldn't confirm the submission. Sync before trying again")); } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={() => !busy && onClose()} title={t("תבנית WhatsApp חדשה", "New WhatsApp template")} width="max-w-6xl" footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>{t("ביטול", "Cancel")}</Button><Button onClick={submit} loading={busy} disabled={!/^[a-z0-9_]+$/.test(name) || (!isAuth && !body.trim())} data-testid="tb-submit">{t("הגש לאישור Meta", "Submit for Meta review")}</Button></>}>
      <div className="tb-grid" data-testid="template-builder">
        <div className="space-y-3">
          <section className="tb-section"><h3>{t("קטגוריה", "Category")}</h3><p>{t("Meta מתמחרת ומאשרת לפי הקטגוריה. תבנית שיווקית שהוגשה כשירות תסווג מחדש.", "Meta prices and reviews templates by category. A marketing template submitted as Utility will be recategorized.")}</p>
            <div className="tb-cat">{CATEGORIES.map(([k, l, d, lEn, dEn]) => <button key={k} type="button" aria-pressed={category === k} onClick={() => setCategory(k)} data-testid={`tb-cat-${k}`}><b>{t(l, lEn)}</b><small>{t(d, dEn)}</small></button>)}</div></section>
          <section className="tb-section grid sm:grid-cols-2 gap-2"><Input label={t("שם התבנית (אנגלית קטנה, ספרות, _)", "Template name (lowercase letters, digits, _)")} value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))} placeholder="order_update" ltr data-testid="tb-name" />
            <Select label={t("שפה", "Language")} value={language} onChange={(e) => setLanguage(e.target.value)} data-testid="tb-language">{Object.entries(TEMPLATE_LANGUAGES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></section>
          {isAuth ? (
            <section className="tb-section" data-testid="tb-auth"><h3>{t("תבנית אימות (OTP)", "Authentication template (OTP)")}</h3><p>{t("Meta קובעת את נוסח ההודעה; אפשר להוסיף המלצת אבטחה, תוקף ואת סוג הכפתור.", "Meta sets the message wording; you can add a security recommendation, an expiry time and the button type.")}</p>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={auth.addSecurityRecommendation} onChange={(e) => setAuth({ ...auth, addSecurityRecommendation: e.target.checked })} /> {t("הוסף המלצת אבטחה (\"אין לשתף את הקוד\")", "Add security recommendation (\"Do not share this code\")")}</label>
              <div className="grid sm:grid-cols-2 gap-2 mt-2"><Input label={t("תוקף הקוד (דקות, 1–90)", "Code expiry (minutes, 1–90)")} type="number" min={1} max={90} value={String(auth.codeExpirationMinutes)} onChange={(e) => setAuth({ ...auth, codeExpirationMinutes: Number(e.target.value) || 10 })} ltr />
                <Select label={t("כפתור", "Button")} value={auth.otpType} onChange={(e) => setAuth({ ...auth, otpType: e.target.value as "COPY_CODE" | "ONE_TAP" })}><option value="COPY_CODE">{t("העתקת קוד", "Copy code")}</option><option value="ONE_TAP">{t("מילוי אוטומטי (Android)", "One-tap autofill (Android)")}</option></Select></div></section>
          ) : <>
            <section className="tb-section"><h3>{t("כותרת", "Header")} <span className="text-xs text-muted">{t("(לא חובה)", "(optional)")}</span></h3>
              <div className="tb-seg">{HEADERS.map(([k, l, lEn]) => <button key={k} type="button" aria-pressed={headerFormat === k} onClick={() => setHeaderFormat(k)} data-testid={`tb-header-${k}`}>{t(l, lEn)}</button>)}</div>
              {headerFormat === "TEXT" && <div className="grid sm:grid-cols-2 gap-2 mt-2"><Input label={t(`טקסט הכותרת (${headerText.length}/60)`, `Header text (${headerText.length}/60)`)} maxLength={60} value={headerText} onChange={(e) => setHeaderText(e.target.value)} data-testid="tb-header-text" />{headerHasVar ? <Input label={t("דוגמה למשתנה {{1}} בכותרת", "Sample for header variable {{1}}")} value={headerExample} onChange={(e) => setHeaderExample(e.target.value)} /> : <div className="text-xs text-muted self-end pb-2"><button type="button" className="lead-link" onClick={() => setHeaderText((h) => `${h}{{1}}`)}>{t("+ הוסף משתנה", "+ Add variable")}</button> {t("(משתנה אחד)", "(one variable)")}</div>}</div>}
              {headerFormat === "IMAGE" && <><TemplateImageUpload value={image} onChange={setImage} />{!image && <details className="mt-2 text-xs"><summary className="cursor-pointer text-muted">{t("לחלופין: קישור ציבורי לתמונה (מתקדם)", "Alternatively: a public image link (advanced)")}</summary><Input label={t("קישור https לתמונת JPG/PNG עד 5MB", "https link to a JPG/PNG image up to 5MB")} value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} placeholder="https://…" ltr data-testid="tb-media" /></details>}</>}
              {["VIDEO", "DOCUMENT"].includes(headerFormat) && <div className="mt-2"><Input label={t(`קישור לקובץ לדוגמה (${headerFormat === "IMAGE" ? "JPG/PNG עד 5MB" : headerFormat === "VIDEO" ? "MP4 עד 16MB" : "PDF"}) – Meta בודקת אותו`, `Sample file link (${headerFormat === "IMAGE" ? "JPG/PNG up to 5MB" : headerFormat === "VIDEO" ? "MP4 up to 16MB" : "PDF"}) – reviewed by Meta`)} value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} placeholder="https://…" ltr data-testid="tb-media" /><p className="text-xs text-muted mt-1">{t("בכל שליחה מצרפים את הקובץ עצמו (קישור) – הדוגמה רק לאישור.", "The actual file (link) is attached on each send – the sample is only for review.")}</p></div>}
              {headerFormat === "LOCATION" && <p className="text-xs text-muted mt-2">{t("המיקום נקבע בכל שליחה (קו רוחב/אורך, שם וכתובת).", "The location is set on each send (latitude/longitude, name and address).")}</p>}
            </section>
            <section className="tb-section"><h3>{t("גוף ההודעה", "Body")}</h3><p>{t("עד 1024 תווים. *מודגש* _נטוי_ ~קו חוצה~. משתנים ממוספרים ברצף – אסור שההודעה תתחיל או תסתיים במשתנה.", "Up to 1024 characters. *bold* _italic_ ~strikethrough~. Variables are numbered in sequence – the message may not start or end with a variable.")}</p>
              <div className="flex gap-1 mb-1"><Button size="sm" variant="ghost" onClick={() => wrap("*")}><b>B</b></Button><Button size="sm" variant="ghost" onClick={() => wrap("_")}><i>I</i></Button><Button size="sm" variant="ghost" onClick={() => wrap("~")}><s>S</s></Button><Button size="sm" variant="ghost" onClick={addVar} data-testid="tb-add-var">{t("+ משתנה", "+ Variable")}</Button><span className="ms-auto text-xs text-muted self-center">{body.length}/1024</span></div>
              <Textarea rows={6} maxLength={1024} value={body} onChange={(e) => setBody(e.target.value)} placeholder={t("שלום {{1}}, ההזמנה שלך מספר {{2}} אושרה.", "Hi {{1}}, your order number {{2}} has been confirmed.")} data-testid="tb-body" />
              {keys.length > 0 && <div className="grid sm:grid-cols-2 gap-2 mt-2">{keys.map((k) => <Input key={k} label={t(`דוגמה ל-{{${k}}}`, `Sample for {{${k}}}`)} value={examples[k] ?? ""} onChange={(e) => setExamples({ ...examples, [k]: e.target.value })} data-testid={`tb-example-${k}`} />)}</div>}
            </section>
            <section className="tb-section"><h3>{t("כותרת תחתונה", "Footer")} <span className="text-xs text-muted">{t("(לא חובה)", "(optional)")}</span></h3><Input label={`${footer.length}/60`} maxLength={60} value={footer} onChange={(e) => setFooter(e.target.value)} placeholder={t("להסרה השיבו הסר", "Reply STOP to unsubscribe")} data-testid="tb-footer" /></section>
            <section className="tb-section"><h3>{t("כפתורים", "Buttons")} <span className="text-xs text-muted">{t("(עד 10)", "(up to 10)")}</span></h3><p>{t("תגובה מהירה, מעבר לאתר (עד 2, אפשר קישור דינמי …/{{1}}), חיוג למספר (1) והעתקת קוד (1).", "Quick reply, visit website (up to 2, dynamic link …/{{1}} allowed), call phone number (1) and copy code (1).")}</p>
              <div className="space-y-2">{buttons.map((b, i) => (
                <div key={i} className="tb-btn-row" data-testid={`tb-button-${i}`}>
                  <b className="text-xs w-full">{(() => { const bt = BUTTON_TYPES.find(([type]) => type === b.type); return bt ? t(bt[1], bt[2]) : null; })()}</b>
                  {b.type !== "COPY_CODE" && <Input aria-label={t("טקסט הכפתור", "Button text")} placeholder={t("טקסט (עד 25)", "Text (up to 25)")} maxLength={25} value={b.text} onChange={(e) => setBtn(i, { text: e.target.value })} className="w-44" />}
                  {b.type === "URL" && <><Input aria-label={t("כתובת", "URL")} value={b.url} onChange={(e) => setBtn(i, { url: e.target.value })} ltr className="w-64" placeholder="https://site.com/order/{{1}}" />{/\{\{1\}\}$/.test(b.url) && <Input aria-label={t("כתובת לדוגמה", "Sample URL")} value={b.example ?? ""} onChange={(e) => setBtn(i, { example: e.target.value })} ltr className="w-64" placeholder="https://site.com/order/123" />}</>}
                  {b.type === "PHONE_NUMBER" && <Input aria-label={t("מספר", "Phone number")} value={b.phone} onChange={(e) => setBtn(i, { phone: e.target.value })} ltr className="w-44" />}
                  {b.type === "COPY_CODE" && <Input aria-label={t("קוד לדוגמה", "Sample code")} placeholder={t("קוד לדוגמה (עד 15)", "Sample code (up to 15)")} maxLength={15} value={b.example} onChange={(e) => setBtn(i, { example: e.target.value })} ltr className="w-44" />}
                  <button type="button" onClick={() => setButtons((l) => l.filter((_, j) => j !== i))} aria-label={t("הסר כפתור", "Remove button")}><Trash2 size={15} /></button>
                </div>))}
              </div>
              <div className="flex flex-wrap gap-2 mt-2">{BUTTON_TYPES.map(([type, l, lEn]) => <Button key={type} size="sm" variant="secondary" disabled={!canAdd(type)} onClick={() => setButtons((list) => { const next = [...list, blankButton(type)]; return type === "QUICK_REPLY" ? [...next.filter((x) => x.type === "QUICK_REPLY"), ...next.filter((x) => x.type !== "QUICK_REPLY")] : next; })} data-testid={`tb-add-${type}`}><Plus size={13} />{t(l, lEn)}</Button>)}</div>
            </section>
          </>}
        </div>
        <div className="sticky top-0 self-start space-y-2"><div className="text-sm font-medium">{t("תצוגה מקדימה", "Preview")}</div><WhatsAppPreview model={preview} businessName={businessName} /><p className="text-[11px] text-muted text-center">{t("כך תיראה ההודעה אצל הלקוח (עם ערכי הדוגמה)", "How the message will look to the customer (with sample values)")}</p></div>
      </div>
    </Modal>
  );
}
