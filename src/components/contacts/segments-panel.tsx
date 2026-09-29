"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, Search, Trash2, X } from "lucide-react";
import { api } from "@/lib/client/api";
import dynamic from "next/dynamic";
import type { AudienceOptions } from "@/components/campaigns/audience-editor";
// The rule editor (and its validation) loads only when a segment is being edited.
const AudienceEditor = dynamic(() => import("@/components/campaigns/audience-editor").then((m) => m.AudienceEditor), { ssr: false });
import { defaultAudience } from "@/lib/audience-defaults";
import type { AudienceNode } from "@/lib/audiences";
import { useT } from "@/components/i18n/LangProvider";

type Seg = { id: string; name: string; dynamic: boolean; count: number | null };
async function j<T>(url: string, init?: RequestInit, failMsg = "Action failed"): Promise<T> { const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } }); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error ?? failMsg); return d as T; }

/** "סגמנטים": saved segments (conditions) and lists; click filters the contacts table; + builds a new segment. */
export function SegmentsPanel({ selected, onSelect, total }: { selected: string | null; onSelect: (id: string | null) => void; total: number }) {
  const [segs, setSegs] = useState<Seg[] | null>(null);
  const t = useT();
  const loc = t.lang === "en" ? "en-GB" : "he-IL";
  const [q, setQ] = useState(""); const [searchOpen, setSearchOpen] = useState(false);
  const [builder, setBuilder] = useState(false);
  const [name, setName] = useState(""); const [seg, setSeg] = useState<AudienceNode>(defaultAudience());
  const [opts, setOpts] = useState<AudienceOptions>({ tags: [], agents: [], campaigns: [] });
  const [preview, setPreview] = useState<number | null>(null); const [busy, setBusy] = useState(false);
  const load = useCallback(() => j<{ lists: Seg[] }>("/api/distribution-lists?counts=1").then((r) => setSegs(r.lists)).catch(() => setSegs([])), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!builder) return;
    Promise.all([api.get<{ items: Array<{ id: string; name: string }> }>("/api/tags").catch(() => ({ items: [] })), api.get<{ items: Array<{ id: string; fullName: string }> }>("/api/users").catch(() => ({ items: [] })), j<{ campaigns: Array<{ id: string; name: string }> }>("/api/campaigns").catch(() => ({ campaigns: [] }))])
      .then(([t, u, c]) => setOpts({ tags: t.items.map((x) => ({ id: x.id, name: x.name })), agents: u.items.map((x) => ({ id: x.id, name: x.fullName })), campaigns: c.campaigns.map((x) => ({ id: x.id, name: x.name })) }));
  }, [builder]);
  useEffect(() => { if (!builder) return; setPreview(null); const t = setTimeout(() => j<{ matched: number }>("/api/distribution-lists/preview", { method: "POST", body: JSON.stringify({ segment: seg }) }).then((r) => setPreview(r.matched)).catch(() => setPreview(null)), 500); return () => clearTimeout(t); }, [seg, builder]);
  async function save() {
    setBusy(true);
    try { const r = await j<{ list: { id: string } }>("/api/distribution-lists", { method: "POST", body: JSON.stringify({ name: name.trim(), segment: seg, contactIds: [] }) }, t("הפעולה נכשלה", "Action failed")); toast.success(t("הסגמנט נשמר", "Segment saved")); setBuilder(false); setName(""); setSeg(defaultAudience()); await load(); onSelect(r.list.id); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  async function remove(s: Seg) { if (!confirm(t(`למחוק את "${s.name}"? אנשי הקשר עצמם לא יימחקו.`, `Delete "${s.name}"? The contacts themselves won't be deleted.`))) return; try { await j(`/api/distribution-lists/${s.id}`, { method: "DELETE" }, t("הפעולה נכשלה", "Action failed")); if (selected === s.id) onSelect(null); await load(); } catch (e) { toast.error((e as Error).message); } }
  const visible = (segs ?? []).filter((s) => !q.trim() || s.name.includes(q.trim()));
  return (
    <aside className="seg" aria-label={t("סגמנטים", "Segments")} data-testid="segments-panel">
      <header><h3>{t("סגמנטים", "Segments")} ({segs?.length ?? 0})</h3><div className="seg-tools"><button onClick={() => setSearchOpen((o) => !o)} aria-label={t("חיפוש סגמנט", "Search segments")}><Search size={15} /></button><button onClick={() => setBuilder(true)} aria-label={t("סגמנט חדש", "New segment")} data-testid="segment-new"><Plus size={15} /></button></div></header>
      {searchOpen && <input className="cmp-input" placeholder={t("חיפוש סגמנט", "Search segments")} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />}
      <button className={`seg-item ${selected === null ? "active" : ""}`} onClick={() => onSelect(null)} data-testid="segment-all"><span>{t("כל אנשי הקשר", "All contacts")}</span>{selected === null && <em>{total.toLocaleString(loc)}</em>}</button>
      {segs === null ? <p className="seg-hint">{t("טוען…", "Loading…")}</p> : visible.map((s) => (
        <div key={s.id} className={`seg-item ${selected === s.id ? "active" : ""}`}><button onClick={() => onSelect(s.id)} data-testid={`segment-${s.id}`}><span>{s.name}</span><em>{s.count === null ? "—" : s.count.toLocaleString(loc)}{s.dynamic ? "" : t(" · רשימה", " · List")}</em></button><button className="seg-del" onClick={() => remove(s)} aria-label={t(`מחק ${s.name}`, `Delete ${s.name}`)}><Trash2 size={13} /></button></div>
      ))}
      {builder && <div className="wz-modal" role="dialog" aria-label={t("סגמנט חדש", "New segment")}><div className="wz-modal-box seg-builder"><header><strong>{t("סגמנט חדש", "New segment")}</strong><button onClick={() => setBuilder(false)} aria-label={t("סגור", "Close")}><X size={18} /></button></header>
        <div className="seg-builder-body">
          <label className="wz-field"><span className="wz-label">{t("שם הסגמנט", "Segment name")}</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("למשל: לא רכשו ב-30 יום", "e.g. No purchase in 30 days")} data-testid="segment-name" /></label>
          <p className="seg-hint">{t("הסגמנט דינמי: הוא מחושב מחדש בכל פעם (אנשי קשר חדשים שעומדים בתנאים נכנסים אליו אוטומטית), ואפשר להשתמש בו גם כקהל בקמפיינים.", "The segment is dynamic: it's recalculated each time (new contacts that match the conditions join automatically), and it can also be used as a campaign audience.")}</p>
          <AudienceEditor value={seg} onChange={setSeg} options={opts} />
          <p className="seg-count" data-testid="segment-preview">{preview === null ? t("מחשב…", "Calculating…") : t(`${preview.toLocaleString(loc)} אנשי קשר עומדים בתנאים כרגע`, `${preview.toLocaleString(loc)} contacts currently match`)}</p>
        </div>
        <div className="wz-modal-actions"><button className="wz-btn ghost" onClick={() => setBuilder(false)}>{t("ביטול", "Cancel")}</button><button className="wz-btn primary" disabled={busy || !name.trim()} onClick={save} data-testid="segment-save">{t("שמירת סגמנט", "Save segment")}</button></div>
      </div></div>}
    </aside>
  );
}
