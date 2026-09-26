"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, Search, Trash2, X } from "lucide-react";
import { api } from "@/lib/client/api";
import { AudienceEditor, type AudienceOptions } from "@/components/campaigns/audience-editor";
import { defaultAudience, type AudienceNode } from "@/lib/audiences";

type Seg = { id: string; name: string; dynamic: boolean; count: number | null };
async function j<T>(url: string, init?: RequestInit): Promise<T> { const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } }); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error ?? "הפעולה נכשלה"); return d as T; }

/** "סגמנטים": saved segments (conditions) and lists; click filters the contacts table; + builds a new segment. */
export function SegmentsPanel({ selected, onSelect, total }: { selected: string | null; onSelect: (id: string | null) => void; total: number }) {
  const [segs, setSegs] = useState<Seg[] | null>(null);
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
    try { const r = await j<{ list: { id: string } }>("/api/distribution-lists", { method: "POST", body: JSON.stringify({ name: name.trim(), segment: seg, contactIds: [] }) }); toast.success("הסגמנט נשמר"); setBuilder(false); setName(""); setSeg(defaultAudience()); await load(); onSelect(r.list.id); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  async function remove(s: Seg) { if (!confirm(`למחוק את "${s.name}"? אנשי הקשר עצמם לא יימחקו.`)) return; try { await j(`/api/distribution-lists/${s.id}`, { method: "DELETE" }); if (selected === s.id) onSelect(null); await load(); } catch (e) { toast.error((e as Error).message); } }
  const visible = (segs ?? []).filter((s) => !q.trim() || s.name.includes(q.trim()));
  return (
    <aside className="seg" aria-label="סגמנטים" data-testid="segments-panel">
      <header><h3>סגמנטים ({segs?.length ?? 0})</h3><div className="seg-tools"><button onClick={() => setSearchOpen((o) => !o)} aria-label="חיפוש סגמנט"><Search size={15} /></button><button onClick={() => setBuilder(true)} aria-label="סגמנט חדש" data-testid="segment-new"><Plus size={15} /></button></div></header>
      {searchOpen && <input className="cmp-input" placeholder="חיפוש סגמנט" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />}
      <button className={`seg-item ${selected === null ? "active" : ""}`} onClick={() => onSelect(null)} data-testid="segment-all"><span>כל אנשי הקשר</span>{selected === null && <em>{total.toLocaleString("he-IL")}</em>}</button>
      {segs === null ? <p className="seg-hint">טוען…</p> : visible.map((s) => (
        <div key={s.id} className={`seg-item ${selected === s.id ? "active" : ""}`}><button onClick={() => onSelect(s.id)} data-testid={`segment-${s.id}`}><span>{s.name}</span><em>{s.count === null ? "—" : s.count.toLocaleString("he-IL")}{s.dynamic ? "" : " · רשימה"}</em></button><button className="seg-del" onClick={() => remove(s)} aria-label={`מחק ${s.name}`}><Trash2 size={13} /></button></div>
      ))}
      {builder && <div className="wz-modal" role="dialog" aria-label="סגמנט חדש"><div className="wz-modal-box seg-builder"><header><strong>סגמנט חדש</strong><button onClick={() => setBuilder(false)} aria-label="סגור"><X size={18} /></button></header>
        <div className="seg-builder-body">
          <label className="wz-field"><span className="wz-label">שם הסגמנט</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="למשל: לא רכשו ב-30 יום" data-testid="segment-name" /></label>
          <p className="seg-hint">הסגמנט דינמי: הוא מחושב מחדש בכל פעם (אנשי קשר חדשים שעומדים בתנאים נכנסים אליו אוטומטית), ואפשר להשתמש בו גם כקהל בקמפיינים.</p>
          <AudienceEditor value={seg} onChange={setSeg} options={opts} />
          <p className="seg-count" data-testid="segment-preview">{preview === null ? "מחשב…" : `${preview.toLocaleString("he-IL")} אנשי קשר עומדים בתנאים כרגע`}</p>
        </div>
        <div className="wz-modal-actions"><button className="wz-btn ghost" onClick={() => setBuilder(false)}>ביטול</button><button className="wz-btn primary" disabled={busy || !name.trim()} onClick={save} data-testid="segment-save">שמירת סגמנט</button></div>
      </div></div>}
    </aside>
  );
}
