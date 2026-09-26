"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, qs } from "@/lib/client/api";
import { useDialer } from "@/components/telephony/DialerProvider";
import { Badge, Button, EmptyState, Input, Modal, Phone, Select, Spinner, Textarea } from "@/components/ui";
import { formatPhone, relativeTime } from "@/lib/client/format";
import { OUTCOMES } from "@/lib/outcomes";
import { useMe } from "@/lib/client/use-me";
import { SegmentsPanel } from "@/components/contacts/segments-panel";

interface Row {
  id: string;
  fullName: string;
  phoneE164: string;
  email: string | null;
  company: string | null;
  city: string | null;
  source: string | null;
  consentStatus: string;
  createdAt: string;
  lastActivityAt: string | null;
  isDnc: boolean;
  suppression: "marketing" | "all" | null;
  owner: { fullName: string } | null;
  tags: Array<{ id: string; name: string; color: string }>;
  _count: { calls: number; conversations: number; leads: number };
  lastCall: { createdAt: string; outcome: string | null } | null;
}

const CONSENT: Record<string, { label: string; tone: "good" | "bad" | "neutral" }> = { OPTED_IN: { label: "הסכמה", tone: "good" }, OPTED_OUT: { label: "הוסר", tone: "bad" }, UNKNOWN: { label: "ללא הסכמה", tone: "neutral" } };

export default function ContactsPage() {
  const { dial, state } = useDialer();
  const me = useMe();
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ q: "", source: "", city: "", neverCalled: "", consent: "", tagId: "", hasOpenLead: "" });
  const [segmentId, setSegmentId] = useState<string | null>(null);
  const [tags, setTags] = useState<Array<{ id: string; name: string }>>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [form, setForm] = useState({ fullName: "", phone: "", email: "", company: "", city: "", source: "", notes: "", consentStatus: "UNKNOWN", consentEvidence: "" });
  const [csv, setCsv] = useState("");
  const [listName, setListName] = useState("");

  useEffect(() => { api.get<{ items: Array<{ id: string; name: string }> }>("/api/tags").then((r) => setTags(r.items)).catch(() => undefined); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<{ items: Row[]; total: number }>(`/api/contacts${qs({ ...filter, segmentId: segmentId ?? undefined, page, limit: 30 })}`);
      setRows(r.items);
      setTotal(r.total);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filter, page, segmentId]);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  async function create() {
    try {
      const c = await api.post<{ id: string }>("/api/contacts", { ...form, consentEvidence: form.consentEvidence || undefined });
      toast.success("איש הקשר נוצר");
      setCreateOpen(false);
      setForm({ fullName: "", phone: "", email: "", company: "", city: "", source: "", notes: "", consentStatus: "UNKNOWN", consentEvidence: "" });
      load();
      return c;
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function importCsv() {
    const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    const header = lines[0].split(/[,\t]/).map((h) => h.trim().toLowerCase());
    const idx = (names: string[]) => header.findIndex((h) => names.includes(h));
    const iName = idx(["name", "fullname", "שם", "שם מלא"]);
    const iPhone = idx(["phone", "טלפון", "mobile", "נייד"]);
    if (iName < 0 || iPhone < 0) return toast.error("נדרשות עמודות שם וטלפון בשורה הראשונה");
    const iEmail = idx(["email", "אימייל"]), iCompany = idx(["company", "חברה"]), iCity = idx(["city", "עיר"]), iSource = idx(["source", "מקור"]), iConsent = idx(["consent", "consentstatus", "הסכמה"]);
    const rowsIn = lines.slice(1).map((l) => {
      const c = l.split(/[,\t]/).map((x) => x.trim());
      const consent = iConsent >= 0 ? c[iConsent]?.toUpperCase() : undefined;
      return { fullName: c[iName] ?? "", phone: c[iPhone] ?? "", email: iEmail >= 0 ? c[iEmail] : undefined, company: iCompany >= 0 ? c[iCompany] : undefined, city: iCity >= 0 ? c[iCity] : undefined, source: iSource >= 0 ? c[iSource] : undefined, consentStatus: consent && ["OPTED_IN", "OPTED_OUT", "UNKNOWN"].includes(consent) ? consent : undefined };
    }).filter((r) => r.fullName && r.phone);
    try {
      const r = await api.post<{ created: number; updated: number; invalid: number; errors: Array<{ row: number; phone: string; reason: string }> }>("/api/contacts/import", { rows: rowsIn, source: "csv" });
      toast.success(`נוצרו ${r.created}, עודכנו ${r.updated}, לא תקינים ${r.invalid}`);
      if (r.errors?.length) {
        toast.error(`שגיאות: ${r.errors.slice(0, 5).map((e) => `שורה ${e.row + 1} (${e.phone}): ${e.reason}`).join(" · ")}${r.errors.length > 5 ? ` ועוד ${r.errors.length - 5}` : ""}`, { duration: 15000 });
        // Downloadable error report (row, phone, reason) for fixing the source file.
        const csv = "\uFEFF" + ["row,phone,reason", ...r.errors.map((e) => `${e.row + 1},"${String(e.phone).replace(/"/g, '""')}","${e.reason.replace(/"/g, '""')}"`)].join("\n");
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
        const a = document.createElement("a"); a.href = url; a.download = `import-errors-${Date.now()}.csv`; a.click(); URL.revokeObjectURL(url);
      }
      setImportOpen(false);
      setCsv("");
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function createListFromFilter() {
    try {
      const r = await api.post<{ id: string; added: number }>("/api/lists", { name: listName, filter: { q: filter.q || undefined, source: filter.source || undefined, city: filter.city || undefined, neverCalled: filter.neverCalled || undefined } });
      toast.success(`הרשימה נוצרה עם ${r.added} לידים`);
      setListOpen(false);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const canDial = Boolean(me?.modules.telephony) && Boolean(state) && !state?.activeCall && !state?.wrapUpCall;
  const isManager = me?.user.role === "manager" || me?.user.role === "owner";

  return (
    <div className="contacts-layout">
    {isManager && <SegmentsPanel selected={segmentId} onSelect={(id) => { setPage(1); setSegmentId(id); }} total={total} />}
    <div className="p-5 space-y-4 min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">אנשי קשר</h1>
        <span className="text-xs text-muted tabular">{total} רשומות</span>
        <div className="ms-auto flex flex-wrap gap-2">
          {isManager && <Link href="/contacts/duplicates" className="inline-flex items-center h-8 px-3 text-xs rounded-md border border-line text-muted hover:text-text">כפילויות</Link>}
          {isManager && <Link href="/api/contacts/export" prefetch={false} className="inline-flex items-center h-8 px-3 text-xs rounded-md border border-line text-muted hover:text-text">ייצוא CSV</Link>}
          {isManager && me?.modules.telephony && <Button variant="secondary" size="sm" onClick={() => { setListName(`רשימה מסינון · ${new Date().toLocaleDateString("he-IL")}`); setListOpen(true); }}>רשימת חיוג מהסינון</Button>}
          {isManager && <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>ייבוא CSV</Button>}
          <Button size="sm" onClick={() => setCreateOpen(true)}>+ איש קשר</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-2">
        <Input placeholder="חיפוש שם / טלפון / אימייל / חברה" value={filter.q} onChange={(e) => { setPage(1); setFilter({ ...filter, q: e.target.value }); }} className="xl:col-span-2" />
        <Input placeholder="מקור" value={filter.source} onChange={(e) => { setPage(1); setFilter({ ...filter, source: e.target.value }); }} />
        <Input placeholder="עיר" value={filter.city} onChange={(e) => { setPage(1); setFilter({ ...filter, city: e.target.value }); }} />
        <Select value={filter.consent} onChange={(e) => { setPage(1); setFilter({ ...filter, consent: e.target.value }); }}><option value="">כל ההסכמות</option><option value="OPTED_IN">עם הסכמה</option><option value="OPTED_OUT">הוסרו</option><option value="UNKNOWN">ללא הסכמה</option></Select>
        <Select value={filter.tagId} onChange={(e) => { setPage(1); setFilter({ ...filter, tagId: e.target.value }); }}><option value="">כל התגיות</option>{tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
        <Select value={filter.hasOpenLead || filter.neverCalled ? (filter.hasOpenLead ? "lead" : "nevercalled") : ""} onChange={(e) => { setPage(1); setFilter({ ...filter, hasOpenLead: e.target.value === "lead" ? "true" : "", neverCalled: e.target.value === "nevercalled" ? "true" : "" }); }}><option value="">הכול</option><option value="lead">עם ליד פתוח</option><option value="nevercalled">מעולם לא חויגו</option></Select>
      </div>

      {loading && rows.length === 0 ? (
        <div className="flex justify-center p-10"><Spinner /></div>
      ) : rows.length === 0 ? (
        <EmptyState title="אין אנשי קשר" hint="הוסף איש קשר, ייבא CSV, או קבל הודעת WhatsApp / שיחה נכנסת – כרטיס נוצר אוטומטית" />
      ) : (
        <div className="bg-panel border border-line rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted bg-white/3">
              <tr>
                <th className="text-start px-3 h-9 font-medium">שם</th>
                <th className="text-start px-3 font-medium">טלפון</th>
                <th className="text-start px-3 font-medium">תגיות</th>
                <th className="text-start px-3 font-medium">מקור</th>
                <th className="text-start px-3 font-medium">דיוור</th>
                <th className="text-start px-3 font-medium">נציג</th>
                <th className="text-start px-3 font-medium">פעילות</th>
                <th className="px-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((c) => (
                <tr key={c.id} className="hover:bg-white/3">
                  <td className="px-3 h-11">
                    <Link href={`/contacts/${c.id}`} className="font-medium hover:underline">{c.fullName}</Link>
                    <span className="block text-[11px] text-muted truncate">{[c.company, c.city].filter(Boolean).join(" · ")}{c._count.leads ? ` · ${c._count.leads} לידים פתוחים` : ""}</span>
                  </td>
                  <td className="px-3"><Phone value={formatPhone(c.phoneE164)} />{c.isDnc && <Badge tone="bad" className="ms-2">DNC</Badge>}</td>
                  <td className="px-3"><div className="flex flex-wrap gap-1">{c.tags.slice(0, 3).map((t) => <span key={t.id} className="px-1.5 h-5 rounded text-[11px] inline-flex items-center" style={{ background: `${t.color}33`, color: t.color }}>{t.name}</span>)}{c.tags.length > 3 && <span className="text-[11px] text-muted">+{c.tags.length - 3}</span>}</div></td>
                  <td className="px-3 text-muted">{c.source ?? "—"}</td>
                  <td className="px-3">{c.suppression === "all" ? <Badge tone="bad">לא ליצור קשר</Badge> : c.suppression === "marketing" ? <Badge tone="bad">הוסר מדיוור</Badge> : <Badge tone={CONSENT[c.consentStatus]?.tone ?? "neutral"}>{CONSENT[c.consentStatus]?.label ?? c.consentStatus}</Badge>}</td>
                  <td className="px-3 text-muted">{c.owner?.fullName ?? "—"}</td>
                  <td className="px-3 text-xs text-muted tabular">
                    {c.lastActivityAt ? relativeTime(c.lastActivityAt) : "—"}
                    <span className="block">{c._count.calls} שיחות · {c._count.conversations} התכתבויות{c.lastCall?.outcome ? ` · ${OUTCOMES.find((o) => o.key === c.lastCall!.outcome)?.label ?? ""}` : ""}</span>
                  </td>
                  <td className="px-3 text-end whitespace-nowrap">
                    {me?.modules.telephony && <Button size="sm" variant="good" disabled={!canDial || c.isDnc || c.suppression === "all"} onClick={() => dial({ mode: "manual", contactId: c.id })}>חייג</Button>}
                    <Link href={`/contacts/${c.id}`} className="inline-flex items-center h-8 px-3 text-xs text-muted hover:text-text">כרטיס</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between px-3 h-10 border-t border-line text-xs text-muted">
            <span>עמוד {page} מתוך {Math.max(1, Math.ceil(total / 30))}</span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>הקודם</Button>
              <Button size="sm" variant="ghost" disabled={page * 30 >= total} onClick={() => setPage(page + 1)}>הבא</Button>
            </div>
          </div>
        </div>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="איש קשר חדש" footer={<><Button variant="ghost" onClick={() => setCreateOpen(false)}>ביטול</Button><Button onClick={create} disabled={!form.fullName || !form.phone}>צור</Button></>}>
        <div className="grid md:grid-cols-2 gap-2">
          <Input label="שם מלא" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
          <Input label="טלפון" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} ltr />
          <Input label="אימייל" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} ltr />
          <Input label="חברה" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
          <Input label="עיר" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
          <Input label="מקור" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} />
          <Select label="הסכמה לדיוור שיווקי" value={form.consentStatus} onChange={(e) => setForm({ ...form, consentStatus: e.target.value })}><option value="UNKNOWN">לא ידוע</option><option value="OPTED_IN">קיימת הסכמה</option><option value="OPTED_OUT">ביקש הסרה</option></Select>
          <Input label="אסמכתה להסכמה" value={form.consentEvidence} onChange={(e) => setForm({ ...form, consentEvidence: e.target.value })} hint="חובה לתעד הסכמה לפני דיוור שיווקי" />
          <Textarea label="הערות" rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="md:col-span-2" />
        </div>
      </Modal>
      <Modal open={importOpen} onClose={() => setImportOpen(false)} title="ייבוא אנשי קשר מ-CSV" footer={<><Button variant="ghost" onClick={() => setImportOpen(false)}>ביטול</Button><Button onClick={importCsv} disabled={!csv.trim()}>ייבא</Button></>} width="max-w-2xl">
        <p className="text-xs text-muted mb-2">שורה ראשונה = כותרות (name/שם, phone/טלפון, email, company, city, source, consent). מספרים מנורמלים; כפילויות לפי מספר מעודכנות ולא נוצרות שוב; ייבוא לעולם לא מחזיר איש קשר שהוסר לדיוור.</p>
        <Textarea rows={12} value={csv} onChange={(e) => setCsv(e.target.value)} className="ltr font-mono text-xs" placeholder={"name,phone,email,source,consent\nישראל ישראלי,0501234567,israel@example.com,facebook,OPTED_IN"} />
      </Modal>
      <Modal open={listOpen} onClose={() => setListOpen(false)} title="רשימת חיוג מהסינון הנוכחי" footer={<><Button variant="ghost" onClick={() => setListOpen(false)}>ביטול</Button><Button onClick={createListFromFilter} disabled={!listName}>צור רשימה</Button></>}>
        <Input label="שם הרשימה" value={listName} onChange={(e) => setListName(e.target.value)} />
        <p className="text-xs text-muted mt-2">כל אנשי הקשר שתואמים לסינון ייכנסו לרשימה. מספרים ברשימת DNC / הסרה מלאה מדולגים.</p>
      </Modal>
    </div>
    </div>
  );
}
