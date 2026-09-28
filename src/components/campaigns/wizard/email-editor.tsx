"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, GripVertical, Monitor, Redo2, Smartphone, Trash2, Undo2, ArrowUp, ArrowDown } from "lucide-react";
import { BLOCK_LABELS, newEmailBlock, renderEmailHtml, type EmailBlock, type EmailDesign } from "@/lib/email/blocks";
import { useT } from "@/components/i18n/LangProvider";

const LIBRARY: EmailBlock["type"][] = ["heading", "text", "image", "button", "divider", "spacer", "columns", "social", "link", "footer"];
const NETWORKS = ["facebook", "instagram", "whatsapp", "linkedin", "youtube", "tiktok", "x", "website"] as const;
const FONTS = ["Arial, Helvetica, sans-serif", "Helvetica, Arial, sans-serif", "Georgia, serif", "Tahoma, Verdana, sans-serif", "'Trebuchet MS', sans-serif", "'Courier New', monospace"];

/**
 * Visual email editor: block library (start side), canvas (middle), block/general settings (end side).
 * Drag to reorder (native DnD), duplicate/delete, undo/redo. The document is the same `EmailDesign` the
 * templates use, so the campaign is rendered by the existing HTML renderer.
 */
export function EmailEditor({ design, onChange, preheader }: { design: EmailDesign; onChange: (d: EmailDesign) => void; preheader?: string | null }) {
  const t = useT();
  const [selected, setSelected] = useState<number | null>(null);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [panel, setPanel] = useState<"block" | "general">("general");
  const history = useRef<{ past: EmailDesign[]; future: EmailDesign[] }>({ past: [], future: [] });
  const [hist, setHist] = useState({ past: 0, future: 0 });
  const syncHist = () => setHist({ past: history.current.past.length, future: history.current.future.length });
  const dragFrom = useRef<number | null>(null);
  const html = useMemo(() => renderEmailHtml(design, { preheader }), [design, preheader]);
  useEffect(() => { if (selected !== null && selected >= design.blocks.length) setSelected(null); }, [design.blocks.length, selected]);

  const commit = (next: EmailDesign) => { history.current.past = [...history.current.past.slice(-49), design]; history.current.future = []; syncHist(); onChange(next); };
  const undo = () => { const prev = history.current.past.pop(); if (!prev) return; history.current.future.push(design); syncHist(); onChange(prev); };
  const redo = () => { const next = history.current.future.pop(); if (!next) return; history.current.past.push(design); syncHist(); onChange(next); };
  const blocks = design.blocks;
  const setBlocks = (b: EmailBlock[]) => commit({ ...design, blocks: b });
  const add = (type: EmailBlock["type"], at?: number) => { const i = at ?? (selected !== null ? selected + 1 : blocks.length); const b = [...blocks]; b.splice(i, 0, newEmailBlock(type)); setBlocks(b); setSelected(i); setPanel("block"); };
  const update = (i: number, patch: Partial<EmailBlock>) => setBlocks(blocks.map((b, j) => j === i ? { ...b, ...patch } as EmailBlock : b));
  const move = (i: number, to: number) => { if (to < 0 || to >= blocks.length) return; const b = [...blocks]; const [x] = b.splice(i, 1); b.splice(to, 0, x); setBlocks(b); setSelected(to); };
  const remove = (i: number) => { if (blocks.length <= 1) return; setBlocks(blocks.filter((_, j) => j !== i)); setSelected(null); };
  const duplicate = (i: number) => { const b = [...blocks]; b.splice(i + 1, 0, JSON.parse(JSON.stringify(blocks[i]))); setBlocks(b); setSelected(i + 1); };
  const sel = selected !== null ? blocks[selected] : null;
  const S = design.settings; const setS = (patch: Partial<EmailDesign["settings"]>) => commit({ ...design, settings: { ...S, ...patch } });

  return (
    <div className="ee" data-testid="email-editor">
      <aside className="ee-library" aria-label={t("ספריית בלוקים", "Block library")}>
        <h4>{t("אלמנטים", "Elements")}</h4>
        <div className="ee-lib-grid">{LIBRARY.map((type) => <button key={type} draggable onDragStart={(e) => { e.dataTransfer.setData("text/block-type", type); }} onClick={() => add(type)} data-testid={`ee-add-${type}`}><span className="ee-lib-icon">{ICONS[type]}</span>{BLOCK_LABELS[type]}</button>)}</div>
        <p className="ee-hint">{t("לחיצה מוסיפה אחרי הבלוק שנבחר; אפשר גם לגרור אל המשטח.", "Click adds after the selected block; you can also drag onto the canvas.")}</p>
      </aside>
      <section className="ee-canvas-wrap">
        <div className="ee-toolbar">
          <div className="ee-tools"><button onClick={undo} disabled={!hist.past} aria-label={t("בטל", "Undo")} title={t("בטל (Ctrl+Z)", "Undo (Ctrl+Z)")}><Undo2 size={16} /></button><button onClick={redo} disabled={!hist.future} aria-label={t("בצע שוב", "Redo")}><Redo2 size={16} /></button></div>
          <div className="ee-tools"><button className={device === "desktop" ? "active" : ""} onClick={() => setDevice("desktop")} aria-label={t("תצוגת מחשב", "Desktop view")}><Monitor size={16} /></button><button className={device === "mobile" ? "active" : ""} onClick={() => setDevice("mobile")} aria-label={t("תצוגת נייד", "Mobile view")}><Smartphone size={16} /></button></div>
        </div>
        <div className={`ee-canvas ${device}`} dir={S.direction} style={{ background: S.backgroundColor }} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { const bt = e.dataTransfer.getData("text/block-type") as EmailBlock["type"]; if (bt) add(bt, blocks.length); }}>
          <div className="ee-page" style={{ width: device === "mobile" ? 360 : S.width, background: S.contentColor, color: S.textColor, fontFamily: S.fontFamily, padding: `8px ${S.padding}px` }}>
            {blocks.map((b, i) => (
              <div key={i} className={`ee-block ${selected === i ? "selected" : ""}`} draggable onDragStart={() => { dragFrom.current = i; }} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.stopPropagation(); const bt = e.dataTransfer.getData("text/block-type") as EmailBlock["type"]; if (bt) { add(bt, i); return; } if (dragFrom.current !== null && dragFrom.current !== i) move(dragFrom.current, i); dragFrom.current = null; }} onClick={() => { setSelected(i); setPanel("block"); }} data-testid={`ee-block-${i}`}>
                <div className="ee-block-tools" onClick={(e) => e.stopPropagation()}><span className="ee-grip" title={t("גרור לשינוי סדר", "Drag to reorder")}><GripVertical size={14} /></span><span>{BLOCK_LABELS[b.type]}</span><button onClick={() => move(i, i - 1)} aria-label={t("למעלה", "Move up")}><ArrowUp size={13} /></button><button onClick={() => move(i, i + 1)} aria-label={t("למטה", "Move down")}><ArrowDown size={13} /></button><button onClick={() => duplicate(i)} aria-label={t("שכפל", "Duplicate")}><Copy size={13} /></button><button onClick={() => remove(i)} aria-label={t("מחק", "Delete")} disabled={blocks.length <= 1}><Trash2 size={13} /></button></div>
                <BlockView b={b} s={S} />
              </div>
            ))}
            {!blocks.length && <p className="ee-empty">{t("יש לגרור ולשחרר אלמנטים לכאן", "Drag and drop elements here")}</p>}
          </div>
        </div>
      </section>
      <aside className="ee-settings" aria-label={t("הגדרות", "Settings")}>
        <div className="ee-settings-tabs"><button className={panel === "block" ? "active" : ""} onClick={() => setPanel("block")} disabled={!sel}>{t("הגדרות הבלוק", "Block settings")}</button><button className={panel === "general" ? "active" : ""} onClick={() => setPanel("general")}>{t("הגדרות כלליות", "General settings")}</button></div>
        {panel === "block" && sel && selected !== null && <BlockSettings b={sel} onChange={(patch) => update(selected, patch)} />}
        {panel === "block" && !sel && <p className="ee-hint">{t("בחר בלוק במשטח כדי לערוך אותו.", "Select a block on the canvas to edit it.")}</p>}
        {panel === "general" && <div className="ee-form">
          <label>{t("כיוון", "Direction")}<div className="ee-seg"><button className={S.direction === "rtl" ? "active" : ""} onClick={() => setS({ direction: "rtl" })}>RTL</button><button className={S.direction === "ltr" ? "active" : ""} onClick={() => setS({ direction: "ltr" })}>LTR</button></div></label>
          <label>{t("רוחב (px)", "Width (px)")}<input type="number" min={480} max={720} value={S.width} onChange={(e) => setS({ width: Math.max(480, Math.min(720, Number(e.target.value) || 600)) })} /></label>
          <label>{t("ריווח פנימי (px)", "Padding (px)")}<input type="number" min={0} max={48} value={S.padding} onChange={(e) => setS({ padding: Math.max(0, Math.min(48, Number(e.target.value) || 0)) })} /></label>
          <label>{t("גופן", "Font")}<select value={S.fontFamily} onChange={(e) => setS({ fontFamily: e.target.value })}>{FONTS.map((f) => <option key={f} value={f}>{f.split(",")[0].replace(/'/g, "")}</option>)}</select></label>
          <div className="ee-colors">
            <label>{t("רקע", "Background")}<input type="color" value={S.backgroundColor} onChange={(e) => setS({ backgroundColor: e.target.value })} /></label>
            <label>{t("תוכן", "Content")}<input type="color" value={S.contentColor} onChange={(e) => setS({ contentColor: e.target.value })} /></label>
            <label>{t("טקסט", "Text")}<input type="color" value={S.textColor} onChange={(e) => setS({ textColor: e.target.value })} /></label>
            <label>{t("קישורים", "Links")}<input type="color" value={S.linkColor} onChange={(e) => setS({ linkColor: e.target.value })} /></label>
          </div>
          <p className="ee-hint">{t("ה-HTML לשליחה נוצר מהמבנה הזה (טבלאות, סגנון inline, קישור הסרה קבוע בתחתית).", "The sent HTML is generated from this structure (tables, inline styles, a fixed unsubscribe link at the bottom).")}</p>
        </div>}
      </aside>
      <textarea readOnly hidden value={html} data-testid="ee-html" />
    </div>
  );
}

const ICONS: Record<EmailBlock["type"], string> = { heading: "H", text: "T", image: "🖼", button: "▭", link: "🔗", divider: "—", spacer: "↕", columns: "▥", social: "☆", footer: "✉" };

function BlockView({ b, s }: { b: EmailBlock; s: EmailDesign["settings"] }) {
  const t = useT();
  const align = (a: "start" | "center" | "end") => a === "center" ? "center" : a === "start" ? (s.direction === "rtl" ? "right" : "left") : (s.direction === "rtl" ? "left" : "right");
  switch (b.type) {
    case "heading": return <div style={{ textAlign: align(b.align), fontSize: b.level === 1 ? 26 : b.level === 2 ? 22 : 18, fontWeight: 700, padding: "8px 0" }}>{b.text}</div>;
    case "text": return <div style={{ textAlign: align(b.align), padding: "8px 0", whiteSpace: "pre-wrap" }}>{b.text}</div>;
    case "image": return <div style={{ padding: "8px 0", textAlign: "center" }}>{b.src && b.src !== "https://" ? <img src={b.src} alt={b.alt} style={{ maxWidth: "100%", width: b.width ?? "100%", display: "block", margin: "0 auto" }} /> : <div className="ee-placeholder">{t("תמונה – הזן קישור בהגדרות", "Image – enter a URL in settings")}</div>}</div>;
    case "button": return <div style={{ textAlign: align(b.align), padding: "12px 0" }}><span style={{ display: "inline-block", background: b.color, color: "#fff", padding: "12px 28px", borderRadius: 8, fontWeight: 700 }}>{b.text}</span></div>;
    case "link": return <div style={{ padding: "4px 0" }}><span style={{ color: s.linkColor, textDecoration: "underline" }}>{b.text}</span></div>;
    case "divider": return <hr style={{ border: 0, borderTop: "1px solid #e5e7eb", margin: "8px 0" }} />;
    case "spacer": return <div style={{ height: b.height }} className="ee-spacer" />;
    case "columns": return <div style={{ display: "flex", gap: 12, padding: "8px 0" }}>{b.items.map((c, i) => <div key={i} style={{ flex: 1, fontSize: 14 }}>{c.src ? <img src={c.src} alt={c.title} style={{ width: "100%", borderRadius: 8, display: "block" }} /> : <div className="ee-placeholder small">{t("תמונה", "Image")}</div>}{c.title && <p style={{ fontWeight: 700, margin: "8px 0 4px" }}>{c.title}</p>}{c.text && <p style={{ margin: 0 }}>{c.text}</p>}</div>)}</div>;
    case "social": return <div style={{ textAlign: align(b.align), padding: "12px 0", fontSize: 14 }}>{b.links.map((l, i) => <span key={i} style={{ margin: "0 6px", color: s.linkColor, fontWeight: 600 }}>{l.network}</span>)}</div>;
    case "footer": return <div style={{ textAlign: "center", fontSize: 12, color: "#6b7280", padding: "16px 0" }}>{b.text && <div>{b.text}</div>}<u>{b.unsubscribeText}</u></div>;
  }
}

function BlockSettings({ b, onChange }: { b: EmailBlock; onChange: (patch: Partial<EmailBlock>) => void }) {
  const t = useT();
  const align = (value: "start" | "center" | "end") => <label>{t("יישור", "Alignment")}<div className="ee-seg">{(["start", "center", "end"] as const).map((a) => <button key={a} className={value === a ? "active" : ""} onClick={() => onChange({ align: a } as Partial<EmailBlock>)}>{a === "start" ? t("התחלה", "Start") : a === "center" ? t("מרכז", "Center") : t("סוף", "End")}</button>)}</div></label>;
  switch (b.type) {
    case "heading": return <div className="ee-form"><label>{t("טקסט", "Text")}<textarea rows={2} value={b.text} onChange={(e) => onChange({ text: e.target.value } as Partial<EmailBlock>)} /></label><label>{t("גודל", "Size")}<select value={b.level} onChange={(e) => onChange({ level: Number(e.target.value) as 1 | 2 | 3 } as Partial<EmailBlock>)}><option value={1}>{t("גדול", "Large")}</option><option value={2}>{t("בינוני", "Medium")}</option><option value={3}>{t("קטן", "Small")}</option></select></label>{align(b.align)}</div>;
    case "text": return <div className="ee-form"><label>{t("טקסט", "Text")}<textarea rows={6} value={b.text} onChange={(e) => onChange({ text: e.target.value } as Partial<EmailBlock>)} /></label>{align(b.align)}<p className="ee-hint">{t("**מודגש** למודגש. משתנים:", "**bold** for bold. Variables:")} {t("{{first_name|לקוח}}", "{{first_name|customer}}")}, {"{{name}}"}, {"{{company|}}"}.</p></div>;
    case "image": return <div className="ee-form"><label>{t("קישור לתמונה (https)", "Image URL (https)")}<input dir="ltr" value={b.src} onChange={(e) => onChange({ src: e.target.value } as Partial<EmailBlock>)} /></label><label>{t("טקסט חלופי", "Alt text")}<input value={b.alt} onChange={(e) => onChange({ alt: e.target.value } as Partial<EmailBlock>)} /></label><label>{t("קישור בלחיצה", "Click-through link")}<input dir="ltr" value={b.href ?? ""} onChange={(e) => onChange({ href: e.target.value || undefined } as Partial<EmailBlock>)} /></label><label>{t("רוחב (px)", "Width (px)")}<input type="number" min={50} max={600} value={b.width ?? ""} onChange={(e) => onChange({ width: e.target.value ? Number(e.target.value) : undefined } as Partial<EmailBlock>)} /></label></div>;
    case "button": return <div className="ee-form"><label>{t("טקסט", "Text")}<input value={b.text} onChange={(e) => onChange({ text: e.target.value } as Partial<EmailBlock>)} /></label><label>{t("קישור", "Link")}<input dir="ltr" value={b.href} onChange={(e) => onChange({ href: e.target.value } as Partial<EmailBlock>)} /></label><label>{t("צבע", "Color")}<input type="color" value={b.color} onChange={(e) => onChange({ color: e.target.value } as Partial<EmailBlock>)} /></label>{align(b.align)}</div>;
    case "link": return <div className="ee-form"><label>{t("טקסט", "Text")}<input value={b.text} onChange={(e) => onChange({ text: e.target.value } as Partial<EmailBlock>)} /></label><label>{t("קישור", "Link")}<input dir="ltr" value={b.href} onChange={(e) => onChange({ href: e.target.value } as Partial<EmailBlock>)} /></label></div>;
    case "divider": return <p className="ee-hint">{t("קו מפריד – אין הגדרות.", "Divider – no settings.")}</p>;
    case "spacer": return <div className="ee-form"><label>{t("גובה (px)", "Height (px)")}<input type="number" min={4} max={120} value={b.height} onChange={(e) => onChange({ height: Math.max(4, Math.min(120, Number(e.target.value) || 24)) } as Partial<EmailBlock>)} /></label></div>;
    case "columns": return <div className="ee-form"><label>{t("מספר עמודות", "Number of columns")}<select value={b.items.length} onChange={(e) => { const n = Number(e.target.value); const items = [...b.items]; while (items.length < n) items.push({ title: `עמודה ${items.length + 1}`, text: "", src: undefined, href: undefined }); onChange({ items: items.slice(0, n) } as Partial<EmailBlock>); }}><option value={2}>2</option><option value={3}>3</option></select></label>{b.items.map((c, i) => <fieldset key={i}><legend>{t(`עמודה ${i + 1}`, `Column ${i + 1}`)}</legend><label>{t("כותרת", "Title")}<input value={c.title} onChange={(e) => onChange({ items: b.items.map((x, j) => j === i ? { ...x, title: e.target.value } : x) } as Partial<EmailBlock>)} /></label><label>{t("טקסט", "Text")}<textarea rows={2} value={c.text} onChange={(e) => onChange({ items: b.items.map((x, j) => j === i ? { ...x, text: e.target.value } : x) } as Partial<EmailBlock>)} /></label><label>{t("תמונה (https)", "Image (https)")}<input dir="ltr" value={c.src ?? ""} onChange={(e) => onChange({ items: b.items.map((x, j) => j === i ? { ...x, src: e.target.value || undefined } : x) } as Partial<EmailBlock>)} /></label><label>{t("קישור", "Link")}<input dir="ltr" value={c.href ?? ""} onChange={(e) => onChange({ items: b.items.map((x, j) => j === i ? { ...x, href: e.target.value || undefined } : x) } as Partial<EmailBlock>)} /></label></fieldset>)}</div>;
    case "social": return <div className="ee-form">{b.links.map((l, i) => <div key={i} className="ee-row"><select value={l.network} onChange={(e) => onChange({ links: b.links.map((x, j) => j === i ? { ...x, network: e.target.value as typeof l.network } : x) } as Partial<EmailBlock>)}>{NETWORKS.map((n) => <option key={n} value={n}>{n}</option>)}</select><input dir="ltr" value={l.href} onChange={(e) => onChange({ links: b.links.map((x, j) => j === i ? { ...x, href: e.target.value } : x) } as Partial<EmailBlock>)} /><button onClick={() => onChange({ links: b.links.filter((_, j) => j !== i) } as Partial<EmailBlock>)} disabled={b.links.length <= 1} aria-label={t("הסר", "Remove")}>×</button></div>)}{b.links.length < 8 && <button className="ee-mini" onClick={() => onChange({ links: [...b.links, { network: "website", href: "https://" }] } as Partial<EmailBlock>)}>{t("+ רשת", "+ Network")}</button>}{align(b.align)}</div>;
    case "footer": return <div className="ee-form"><label>{t("טקסט תחתון", "Footer text")}<textarea rows={2} value={b.text} onChange={(e) => onChange({ text: e.target.value } as Partial<EmailBlock>)} /></label><label>{t("טקסט קישור ההסרה", "Unsubscribe link text")}<input value={b.unsubscribeText} onChange={(e) => onChange({ unsubscribeText: e.target.value } as Partial<EmailBlock>)} /></label><p className="ee-hint">{t("קישור ההסרה מוחלף לכל נמען בזמן השליחה.", "The unsubscribe link is replaced per recipient at send time.")}</p></div>;
  }
}
