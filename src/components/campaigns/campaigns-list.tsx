"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CalendarDays, ChevronDown, FileEdit, List, MoreHorizontal, Search, Send, Clock, Hourglass, AlertCircle, Globe, Mail, MessageCircle, Smartphone } from "lucide-react";
import { CAMPAIGN_BUCKET_LABELS, campaignBucket, CHANNEL_LABELS, throttleLabel, type CampaignBucket } from "@/lib/campaigns";
import { Modal, Button } from "@/components/ui";

type ChannelKey = "whatsapp" | "sms" | "email";
interface Campaign { id: string; name: string; status: string; channel: ChannelKey; scheduledAt: string | null; throttle?: { batchSize: number; intervalMinutes: number } | null; statusReason: string | null; createdAt: string; updatedAt: string; list: { name: string }; template: { name: string }; _count: { recipients: number }; counts: Record<string, number> }
interface Draft { id: string; channel: ChannelKey; name: string; step: string; updatedAt: string }
type Row = { kind: "campaign"; c: Campaign } | { kind: "draft"; d: Draft };

const BUCKET_ICON: Record<CampaignBucket, typeof Globe> = { all: Globe, draft: FileEdit, scheduled: CalendarDays, running: Hourglass, sent: Send, failed: AlertCircle };
const CHANNEL_ICON: Record<ChannelKey, typeof Mail> = { whatsapp: MessageCircle, email: Mail, sms: Smartphone };
const fmt = (iso: string, tz: string) => new Date(iso).toLocaleString("he-IL", { timeZone: tz, dateStyle: "short", timeStyle: "short" });

/**
 * Campaigns area (Flashy-style): tabs per channel, status filter on the side, clean rows with one primary action,
 * a "more" menu per status, calendar view. Creation and editing happen in the full-screen builder (/campaigns/wizard/[id]).
 */
export function CampaignsList({ channel, timezone }: { channel: ChannelKey; timezone: string }) {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [bucket, setBucket] = useState<CampaignBucket>("all");
  const [q, setQ] = useState("");
  const [view, setView] = useState<"list" | "calendar">("list");
  const [busy, setBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [rename, setRename] = useState<{ id: string; kind: "campaign" | "draft"; name: string } | null>(null);
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const menuRef = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    try {
      const [c, d] = await Promise.all([fetch(`/api/campaigns?channel=${channel}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`), fetch(`/api/campaigns/drafts?channel=${channel}`)]);
      if (c.ok) setCampaigns((await c.json()).campaigns); if (d.ok) setDrafts((await d.json()).drafts);
    } catch { /* keep the last snapshot */ }
  }, [channel, q]);
  useEffect(() => { const t = setTimeout(load, q ? 350 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (!menu) return; const onDown = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null); }; document.addEventListener("mousedown", onDown); return () => document.removeEventListener("mousedown", onDown); }, [menu]);

  const rows = useMemo<Row[]>(() => {
    const ql = q.trim().toLowerCase();
    const dr: Row[] = drafts.filter((d) => !ql || d.name.toLowerCase().includes(ql)).map((d) => ({ kind: "draft", d }));
    const cr: Row[] = (campaigns ?? []).map((c) => ({ kind: "campaign", c }));
    const all = [...dr, ...cr].filter((r) => bucket === "all" ? true : r.kind === "draft" ? bucket === "draft" : campaignBucket(r.c) === bucket);
    return all.sort((a, b) => new Date(a.kind === "draft" ? a.d.updatedAt : a.c.updatedAt).getTime() < new Date(b.kind === "draft" ? b.d.updatedAt : b.c.updatedAt).getTime() ? 1 : -1);
  }, [campaigns, drafts, bucket, q]);
  const total = (campaigns?.length ?? 0) + drafts.length;

  async function api(url: string, method: string, body?: unknown) {
    const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(typeof data.error === "string" ? data.error : "הפעולה נכשלה");
    return data;
  }
  async function run(key: string, fn: () => Promise<void>) { setBusy(key); setMenu(null); try { await fn(); await load(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); } }
  async function createCampaign() {
    await run("new", async () => { const { draft } = await api("/api/campaigns/drafts", "POST", { channel }); router.push(`/campaigns/wizard/${draft.id}`); });
  }
  async function continueEditing(c: Campaign) {
    await run(c.id, async () => { const { draft } = await api(`/api/campaigns/drafts/from-campaign/${c.id}`, "POST"); router.push(`/campaigns/wizard/${draft.id}`); });
  }
  const primary = (c: Campaign) => {
    const b = campaignBucket(c);
    if (b === "draft") return { label: "המשך עריכה", onClick: () => continueEditing(c) };
    if (b === "sent" || b === "failed") return { label: "צפייה בדוח", href: `/campaigns/report/${c.id}` };
    return { label: "פרטים", href: `/campaigns/report/${c.id}` };
  };
  const progress = (c: Campaign) => {
    const done = (c.counts.SENT ?? 0) + (c.counts.FAILED ?? 0) + (c.counts.SKIPPED ?? 0) + (c.counts.UNKNOWN ?? 0);
    const total = c._count.recipients; if (!total || !["RUNNING", "PAUSED", "COMPLETED"].includes(c.status)) return null;
    return { pct: Math.round(done / total * 100), done, total };
  };
  const dateLine = (c: Campaign) => {
    const b = campaignBucket(c);
    if (b === "scheduled" && c.scheduledAt) return `מתוזמן ל: ${fmt(c.scheduledAt, timezone)}`;
    if (b === "sent" || b === "failed") return `נשלח ב: ${fmt(c.scheduledAt ?? c.updatedAt, timezone)}`;
    if (b === "running") return `בשליחה מ-${fmt(c.scheduledAt ?? c.updatedAt, timezone)}`;
    return `נערך לאחרונה ${fmt(c.updatedAt, timezone)}`;
  };
  const Icon = CHANNEL_ICON[channel];

  const calendarItems = useMemo(() => (campaigns ?? []).filter((c) => c.status !== "DRAFT").map((c) => ({ c, at: new Date(c.scheduledAt ?? c.updatedAt) })), [campaigns]);
  const days = useMemo(() => { const first = new Date(month); const start = new Date(first); start.setDate(1 - first.getDay()); return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; }); }, [month]);

  return (
    <div className="cmp" data-testid="campaigns-list">
      <aside className="cmp-side" aria-label="סינון לפי סטטוס">
        <h3>סינון לפי סטטוס</h3>
        {(Object.keys(CAMPAIGN_BUCKET_LABELS) as CampaignBucket[]).map((k) => { const I = BUCKET_ICON[k]; return <button key={k} className={bucket === k ? "active" : ""} onClick={() => setBucket(k)} data-testid={`bucket-${k}`}><I size={16} /> {CAMPAIGN_BUCKET_LABELS[k]}</button>; })}
      </aside>
      <section className="cmp-main">
        <header className="cmp-head">
          <h1>קמפיינים <span className="cmp-count">({total})</span></h1>
          <div className="cmp-head-actions">
            <label className="cmp-search"><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש" aria-label="חיפוש קמפיינים" data-testid="campaigns-search" /></label>
            <button className="cmp-btn" onClick={() => setView(view === "list" ? "calendar" : "list")} data-testid="campaigns-view-toggle">{view === "list" ? <><CalendarDays size={15} /> תצוגת יומן</> : <><List size={15} /> תצוגת רשימה</>}</button>
            <button className="cmp-btn primary" onClick={createCampaign} disabled={busy === "new"} data-testid="campaign-create">יצירת קמפיין</button>
          </div>
        </header>
        <nav className="campaigns-nav" aria-label="קמפיינים" data-testid="campaigns-nav">
          <div className="campaigns-tabs" role="tablist">{(["whatsapp", "email", "sms"] as ChannelKey[]).map((ch) => <Link key={ch} role="tab" href={`/campaigns/${ch}`} aria-selected={channel === ch} className={channel === ch ? "active" : ""} data-testid={`campaigns-tab-${ch}`}>{ch === "email" ? "דואר אלקטרוני" : ch === "sms" ? "קמפייני SMS" : "וואטסאפ"}</Link>)}</div>
          <div className="campaigns-secondary"><Link href="/audiences" data-testid="campaigns-audiences">קהלים ואנשי קשר</Link><Link href="/templates" data-testid="campaigns-templates">תבניות</Link></div>
        </nav>
        {view === "calendar" ? (
          <div className="cmp-cal" data-testid="campaigns-calendar">
            <div className="cmp-cal-head"><button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="חודש קודם">‹</button><strong>{month.toLocaleDateString("he-IL", { month: "long", year: "numeric" })}</strong><button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="חודש הבא">›</button></div>
            <div className="cmp-cal-grid">
              {["א", "ב", "ג", "ד", "ה", "ו", "ש"].map((d) => <div key={d} className="cmp-cal-dow">{d}</div>)}
              {days.map((d) => { const items = calendarItems.filter((i) => i.at.toDateString() === d.toDateString()); const other = d.getMonth() !== month.getMonth(); return (
                <div key={d.toISOString()} className={`cmp-cal-day ${other ? "other" : ""}`}><span className="cmp-cal-num">{d.getDate()}</span>
                  {items.map(({ c }) => <Link key={c.id} href={`/campaigns/report/${c.id}`} className={`cmp-cal-item b-${campaignBucket(c)}`} title={`${c.name} · ${fmt(c.scheduledAt ?? c.updatedAt, timezone)}`}>{c.name}</Link>)}
                </div>); })}
            </div>
            <p className="cmp-note">קמפיינים מוצגים לפי מועד השליחה או התזמון. טיוטות אינן מופיעות ביומן.</p>
          </div>
        ) : (
          <div className="cmp-rows" data-testid="campaigns-rows">
            {campaigns === null ? <p className="cmp-empty">טוען…</p> : rows.length === 0 ? <p className="cmp-empty" data-testid="campaigns-empty">{q ? "לא נמצאו קמפיינים תואמים" : bucket === "all" ? `עדיין אין קמפייני ${CHANNEL_LABELS[channel]}. לחץ על "יצירת קמפיין" כדי להתחיל.` : "אין קמפיינים בסטטוס הזה"}</p> : rows.map((row) => row.kind === "draft" ? (
              <article key={`d-${row.d.id}`} className="cmp-row" data-testid={`draft-${row.d.id}`}>
                <span className="cmp-row-icon"><FileEdit size={22} /></span>
                <div className="cmp-row-main"><h3>{row.d.name}</h3><p>נערך לאחרונה {fmt(row.d.updatedAt, timezone)} · טיוטה בבנייה</p></div>
                <div className="cmp-row-status"><span className="cmp-badge draft">טיוטה</span></div>
                <div className="cmp-row-actions">
                  <Link href={`/campaigns/wizard/${row.d.id}`} className="cmp-btn outline" data-testid={`draft-continue-${row.d.id}`}>המשך עריכה</Link>
                  <div className="cmp-menu-wrap" ref={menu === `d-${row.d.id}` ? menuRef : undefined}><button className="cmp-btn icon" aria-label="פעולות נוספות" onClick={() => setMenu(menu === `d-${row.d.id}` ? null : `d-${row.d.id}`)}><ChevronDown size={16} /></button>
                    {menu === `d-${row.d.id}` && <div className="cmp-menu" role="menu"><button onClick={() => { setMenu(null); setRename({ id: row.d.id, kind: "draft", name: row.d.name }); }}>שינוי שם</button><button className="danger" onClick={() => { if (confirm(`למחוק את הטיוטה "${row.d.name}"?`)) void run(row.d.id, async () => { await api(`/api/campaigns/drafts/${row.d.id}`, "DELETE"); }); }}>מחיקת טיוטה</button></div>}
                  </div>
                </div>
              </article>
            ) : (() => { const c = row.c; const b = campaignBucket(c); const p = progress(c); const act = primary(c); const id = `c-${c.id}`; return (
              <article key={id} className="cmp-row" data-testid={`campaign-${c.id}`}>
                <span className="cmp-row-icon"><Icon size={22} /></span>
                <div className="cmp-row-main"><h3>{c.name}</h3><p>{dateLine(c)}{c.throttle && ["scheduled", "running"].includes(campaignBucket(c)) ? ` · קצב: ${throttleLabel(c.throttle)}` : ""}{c.statusReason ? <span className="cmp-reason"> · {c.statusReason}</span> : null}</p></div>
                <div className="cmp-row-status"><span className={`cmp-badge ${b}`}>{b === "cancelled" ? "בוטל" : CAMPAIGN_BUCKET_LABELS[b]}</span>{p && <div className="cmp-progress" title={`${p.done} מתוך ${p.total}`}><div style={{ width: `${p.pct}%` }} /><span>{p.pct}%</span></div>}</div>
                <div className="cmp-row-actions">
                  {"href" in act ? <Link href={act.href!} className="cmp-btn outline" data-testid={`campaign-primary-${c.id}`}>{act.label}</Link> : <button className="cmp-btn outline" disabled={busy === c.id} onClick={act.onClick} data-testid={`campaign-primary-${c.id}`}>{act.label}</button>}
                  <div className="cmp-menu-wrap" ref={menu === id ? menuRef : undefined}><button className="cmp-btn icon" aria-label="פעולות נוספות" onClick={() => setMenu(menu === id ? null : id)} data-testid={`campaign-menu-${c.id}`}><MoreHorizontal size={16} /></button>
                    {menu === id && <div className="cmp-menu" role="menu">
                      <Link href={`/campaigns/report/${c.id}`}>דוח ונמענים</Link>
                      <button onClick={() => void run(c.id, async () => { await api(`/api/campaigns/${c.id}/duplicate`, "POST"); toast.success("נוצרה טיוטה חדשה מהקמפיין"); })}>שכפול</button>
                      {["DRAFT", "SCHEDULED", "PAUSED"].includes(c.status) && <button onClick={() => { setMenu(null); setRename({ id: c.id, kind: "campaign", name: c.name }); }}>שינוי שם</button>}
                      {c.status === "SCHEDULED" && <button onClick={() => void run(c.id, async () => { await api(`/api/campaigns/${c.id}`, "PATCH", { action: "unschedule" }); toast.success("התזמון בוטל – הקמפיין חזר לטיוטה"); })}>ביטול תזמון</button>}
                      {["RUNNING", "SCHEDULED"].includes(c.status) && <button onClick={() => void run(c.id, async () => { await api(`/api/campaigns/${c.id}`, "PATCH", { action: "pause" }); })}>השהיה</button>}
                      {c.status === "PAUSED" && <button onClick={() => void run(c.id, async () => { await api(`/api/campaigns/${c.id}`, "PATCH", { action: "resume" }); })}>המשך שליחה</button>}
                      {["SCHEDULED", "RUNNING", "PAUSED"].includes(c.status) && <button className="danger" onClick={() => { if (confirm("לבטל את הקמפיין? הודעות שכבר הועברו לספק לא יבוטלו.")) void run(c.id, async () => { await api(`/api/campaigns/${c.id}`, "PATCH", { action: "cancel" }); }); }}>ביטול קמפיין</button>}
                      {c.status === "DRAFT" && <button className="danger" onClick={() => { if (confirm(`למחוק את הטיוטה "${c.name}"?`)) void run(c.id, async () => { await api(`/api/campaigns/${c.id}`, "DELETE"); }); }}>מחיקת טיוטה</button>}
                      <a href={`/api/campaigns/${c.id}/export`}>ייצוא נמענים (CSV)</a>
                    </div>}
                  </div>
                </div>
              </article>); })())}
          </div>
        )}
      </section>
      <Modal open={Boolean(rename)} onClose={() => setRename(null)} title="שינוי שם" footer={<><Button variant="ghost" onClick={() => setRename(null)}>ביטול</Button><Button onClick={() => rename && void run(rename.id, async () => { await api(rename.kind === "draft" ? `/api/campaigns/drafts/${rename.id}` : `/api/campaigns/${rename.id}`, "PATCH", { name: rename.name }); setRename(null); })}>שמירה</Button></>}>
        {rename && <input className="cmp-input" value={rename.name} onChange={(e) => setRename({ ...rename, name: e.target.value })} aria-label="שם הקמפיין" autoFocus />}
      </Modal>
    </div>
  );
}
