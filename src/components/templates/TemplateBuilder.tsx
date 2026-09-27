"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Button, Input, Modal, Select, Textarea } from "@/components/ui";
import { templateParameterKeys } from "@/lib/campaigns";
import { TEMPLATE_LANGUAGES, type TemplateButtonInput } from "@/lib/validation/template";
import { WhatsAppPreview } from "./WhatsAppPreview";

type Category = "MARKETING" | "UTILITY" | "AUTHENTICATION";
type HeaderFormat = "NONE" | "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION";
const CATEGORIES: Array<[Category, string, string]> = [
  ["MARKETING", "שיווק", "מבצעים, הצעות, עדכוני מוצר, הזמנה לאירוע"],
  ["UTILITY", "שירות (Utility)", "אישור הזמנה, תזכורת לפגישה, עדכון סטטוס, פולואפ"],
  ["AUTHENTICATION", "אימות", "קוד חד-פעמי (OTP) להתחברות או לאימות"],
];
const HEADERS: Array<[HeaderFormat, string]> = [["NONE", "ללא"], ["TEXT", "טקסט"], ["IMAGE", "תמונה"], ["VIDEO", "וידאו"], ["DOCUMENT", "מסמך"], ["LOCATION", "מיקום"]];
const BUTTON_TYPES: Array<[TemplateButtonInput["type"], string]> = [["QUICK_REPLY", "תגובה מהירה"], ["URL", "מעבר לאתר"], ["PHONE_NUMBER", "חיוג למספר"], ["COPY_CODE", "העתקת קוד הנחה"]];
const blankButton = (type: TemplateButtonInput["type"]): TemplateButtonInput => type === "QUICK_REPLY" ? { type, text: "" } : type === "URL" ? { type, text: "", url: "https://", example: "" } : type === "PHONE_NUMBER" ? { type, text: "", phone: "+972" } : { type, example: "" };

/** Meta's template builder – every option (category, language, header types, body with samples, footer, buttons, OTP). */
export function TemplateBuilder({ businessName, onClose }: { businessName?: string; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [language, setLanguage] = useState("he");
  const [category, setCategory] = useState<Category>("UTILITY");
  const [headerFormat, setHeaderFormat] = useState<HeaderFormat>("NONE");
  const [headerText, setHeaderText] = useState("");
  const [headerExample, setHeaderExample] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
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
  const wrap = (ch: string) => setBody((b) => `${b}${ch}טקסט${ch}`);
  const setBtn = (i: number, patch: Partial<TemplateButtonInput>) => setButtons((l) => l.map((b, j) => (j === i ? ({ ...b, ...patch } as TemplateButtonInput) : b)));
  const count = (t: string) => buttons.filter((b) => b.type === t).length;
  const canAdd = (t: TemplateButtonInput["type"]) => buttons.length < 10 && (t === "URL" ? count("URL") < 2 : t === "PHONE_NUMBER" || t === "COPY_CODE" ? count(t) < 1 : true);

  const preview = isAuth
    ? { body: `*123456* הוא קוד האימות שלך.${auth.addSecurityRecommendation ? " מטעמי אבטחה, אין לשתף את הקוד." : ""}`, footer: auth.codeExpirationMinutes ? `תוקף הקוד: ${auth.codeExpirationMinutes} דקות.` : null, buttons: [{ type: "OTP", text: auth.otpType === "ONE_TAP" ? "מילוי אוטומטי" : "העתק קוד" }] }
    : { headerFormat: headerFormat === "NONE" ? null : headerFormat, headerText, body: body || "תוכן ההודעה יופיע כאן", footer, values: { ...examples, h1: headerExample }, buttons: buttons.map((b) => ({ type: b.type, text: b.type === "COPY_CODE" ? "העתק קוד" : b.text })) };

  async function submit() {
    setBusy(true);
    try {
      const payload = { name, language, category, header: isAuth ? { format: "NONE" } : { format: headerFormat, ...(headerFormat === "TEXT" ? { text: headerText, ...(headerHasVar ? { example: headerExample } : {}) } : {}), ...(["IMAGE", "VIDEO", "DOCUMENT"].includes(headerFormat) ? { mediaUrl } : {}) }, body: isAuth ? "" : body, examples: Object.fromEntries(keys.map((k) => [k, examples[k] ?? ""])), footer: isAuth ? undefined : footer || undefined, buttons: isAuth ? [] : buttons, ...(isAuth ? { auth } : {}) };
      const res = await fetch("/api/templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.error || "ההגשה נכשלה"); router.refresh(); return; }
      toast.success("התבנית הוגשה ל-Meta. הסטטוס יתעדכן לאחר האישור (סנכרון)"); onClose(); router.refresh();
    } catch { toast.error("לא ניתן לאמת את ההגשה. יש לסנכרן לפני ניסיון נוסף"); } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={() => !busy && onClose()} title="תבנית WhatsApp חדשה" width="max-w-6xl" footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>ביטול</Button><Button onClick={submit} loading={busy} disabled={!/^[a-z0-9_]+$/.test(name) || (!isAuth && !body.trim())} data-testid="tb-submit">הגש לאישור Meta</Button></>}>
      <div className="tb-grid" data-testid="template-builder">
        <div className="space-y-3">
          <section className="tb-section"><h3>קטגוריה</h3><p>Meta מתמחרת ומאשרת לפי הקטגוריה. תבנית שיווקית שהוגשה כשירות תסווג מחדש.</p>
            <div className="tb-cat">{CATEGORIES.map(([k, l, d]) => <button key={k} type="button" aria-pressed={category === k} onClick={() => setCategory(k)} data-testid={`tb-cat-${k}`}><b>{l}</b><small>{d}</small></button>)}</div></section>
          <section className="tb-section grid sm:grid-cols-2 gap-2"><Input label="שם התבנית (אנגלית קטנה, ספרות, _)" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))} placeholder="order_update" ltr data-testid="tb-name" />
            <Select label="שפה" value={language} onChange={(e) => setLanguage(e.target.value)} data-testid="tb-language">{Object.entries(TEMPLATE_LANGUAGES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></section>
          {isAuth ? (
            <section className="tb-section" data-testid="tb-auth"><h3>תבנית אימות (OTP)</h3><p>Meta קובעת את נוסח ההודעה; אפשר להוסיף המלצת אבטחה, תוקף ואת סוג הכפתור.</p>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={auth.addSecurityRecommendation} onChange={(e) => setAuth({ ...auth, addSecurityRecommendation: e.target.checked })} /> הוסף המלצת אבטחה (&quot;אין לשתף את הקוד&quot;)</label>
              <div className="grid sm:grid-cols-2 gap-2 mt-2"><Input label="תוקף הקוד (דקות, 1–90)" type="number" min={1} max={90} value={String(auth.codeExpirationMinutes)} onChange={(e) => setAuth({ ...auth, codeExpirationMinutes: Number(e.target.value) || 10 })} ltr />
                <Select label="כפתור" value={auth.otpType} onChange={(e) => setAuth({ ...auth, otpType: e.target.value as "COPY_CODE" | "ONE_TAP" })}><option value="COPY_CODE">העתקת קוד</option><option value="ONE_TAP">מילוי אוטומטי (Android)</option></Select></div></section>
          ) : <>
            <section className="tb-section"><h3>כותרת <span className="text-xs text-muted">(לא חובה)</span></h3>
              <div className="tb-seg">{HEADERS.map(([k, l]) => <button key={k} type="button" aria-pressed={headerFormat === k} onClick={() => setHeaderFormat(k)} data-testid={`tb-header-${k}`}>{l}</button>)}</div>
              {headerFormat === "TEXT" && <div className="grid sm:grid-cols-2 gap-2 mt-2"><Input label={`טקסט הכותרת (${headerText.length}/60)`} maxLength={60} value={headerText} onChange={(e) => setHeaderText(e.target.value)} data-testid="tb-header-text" />{headerHasVar ? <Input label="דוגמה למשתנה {{1}} בכותרת" value={headerExample} onChange={(e) => setHeaderExample(e.target.value)} /> : <div className="text-xs text-muted self-end pb-2"><button type="button" className="lead-link" onClick={() => setHeaderText((t) => `${t}{{1}}`)}>+ הוסף משתנה</button> (משתנה אחד)</div>}</div>}
              {["IMAGE", "VIDEO", "DOCUMENT"].includes(headerFormat) && <div className="mt-2"><Input label={`קישור לקובץ לדוגמה (${headerFormat === "IMAGE" ? "JPG/PNG עד 5MB" : headerFormat === "VIDEO" ? "MP4 עד 16MB" : "PDF"}) – Meta בודקת אותו`} value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} placeholder="https://…" ltr data-testid="tb-media" /><p className="text-xs text-muted mt-1">בכל שליחה מצרפים את הקובץ עצמו (קישור) – הדוגמה רק לאישור.</p></div>}
              {headerFormat === "LOCATION" && <p className="text-xs text-muted mt-2">המיקום נקבע בכל שליחה (קו רוחב/אורך, שם וכתובת).</p>}
            </section>
            <section className="tb-section"><h3>גוף ההודעה</h3><p>עד 1024 תווים. *מודגש* _נטוי_ ~קו חוצה~. משתנים ממוספרים ברצף – אסור שההודעה תתחיל או תסתיים במשתנה.</p>
              <div className="flex gap-1 mb-1"><Button size="sm" variant="ghost" onClick={() => wrap("*")}><b>B</b></Button><Button size="sm" variant="ghost" onClick={() => wrap("_")}><i>I</i></Button><Button size="sm" variant="ghost" onClick={() => wrap("~")}><s>S</s></Button><Button size="sm" variant="ghost" onClick={addVar} data-testid="tb-add-var">+ משתנה</Button><span className="ms-auto text-xs text-muted self-center">{body.length}/1024</span></div>
              <Textarea rows={6} maxLength={1024} value={body} onChange={(e) => setBody(e.target.value)} placeholder="שלום {{1}}, ההזמנה שלך מספר {{2}} אושרה." data-testid="tb-body" />
              {keys.length > 0 && <div className="grid sm:grid-cols-2 gap-2 mt-2">{keys.map((k) => <Input key={k} label={`דוגמה ל-{{${k}}}`} value={examples[k] ?? ""} onChange={(e) => setExamples({ ...examples, [k]: e.target.value })} data-testid={`tb-example-${k}`} />)}</div>}
            </section>
            <section className="tb-section"><h3>כותרת תחתונה <span className="text-xs text-muted">(לא חובה)</span></h3><Input label={`${footer.length}/60`} maxLength={60} value={footer} onChange={(e) => setFooter(e.target.value)} placeholder="להסרה השיבו הסר" data-testid="tb-footer" /></section>
            <section className="tb-section"><h3>כפתורים <span className="text-xs text-muted">(עד 10)</span></h3><p>תגובה מהירה, מעבר לאתר (עד 2, אפשר קישור דינמי …/{"{{1}}"}), חיוג למספר (1) והעתקת קוד (1).</p>
              <div className="space-y-2">{buttons.map((b, i) => (
                <div key={i} className="tb-btn-row" data-testid={`tb-button-${i}`}>
                  <b className="text-xs w-full">{BUTTON_TYPES.find(([t]) => t === b.type)?.[1]}</b>
                  {b.type !== "COPY_CODE" && <Input aria-label="טקסט הכפתור" placeholder="טקסט (עד 25)" maxLength={25} value={b.text} onChange={(e) => setBtn(i, { text: e.target.value })} className="w-44" />}
                  {b.type === "URL" && <><Input aria-label="כתובת" value={b.url} onChange={(e) => setBtn(i, { url: e.target.value })} ltr className="w-64" placeholder="https://site.com/order/{{1}}" />{/\{\{1\}\}$/.test(b.url) && <Input aria-label="כתובת לדוגמה" value={b.example ?? ""} onChange={(e) => setBtn(i, { example: e.target.value })} ltr className="w-64" placeholder="https://site.com/order/123" />}</>}
                  {b.type === "PHONE_NUMBER" && <Input aria-label="מספר" value={b.phone} onChange={(e) => setBtn(i, { phone: e.target.value })} ltr className="w-44" />}
                  {b.type === "COPY_CODE" && <Input aria-label="קוד לדוגמה" placeholder="קוד לדוגמה (עד 15)" maxLength={15} value={b.example} onChange={(e) => setBtn(i, { example: e.target.value })} ltr className="w-44" />}
                  <button type="button" onClick={() => setButtons((l) => l.filter((_, j) => j !== i))} aria-label="הסר כפתור"><Trash2 size={15} /></button>
                </div>))}
              </div>
              <div className="flex flex-wrap gap-2 mt-2">{BUTTON_TYPES.map(([t, l]) => <Button key={t} size="sm" variant="secondary" disabled={!canAdd(t)} onClick={() => setButtons((list) => { const next = [...list, blankButton(t)]; return t === "QUICK_REPLY" ? [...next.filter((x) => x.type === "QUICK_REPLY"), ...next.filter((x) => x.type !== "QUICK_REPLY")] : next; })} data-testid={`tb-add-${t}`}><Plus size={13} />{l}</Button>)}</div>
            </section>
          </>}
        </div>
        <div className="sticky top-0 self-start space-y-2"><div className="text-sm font-medium">תצוגה מקדימה</div><WhatsAppPreview model={preview} businessName={businessName} /><p className="text-[11px] text-muted text-center">כך תיראה ההודעה אצל הלקוח (עם ערכי הדוגמה)</p></div>
      </div>
    </Modal>
  );
}
