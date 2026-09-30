"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, qs } from "@/lib/client/api";
import { useDialer } from "@/components/telephony/DialerProvider";
import { Badge, Button, EmptyState, Input, Modal, Phone, Select, Spinner, Textarea } from "@/components/ui";
import { formatPhone, relativeTime } from "@/lib/client/format";
import { OUTCOMES } from "@/lib/outcomes";
import { useMe } from "@/lib/client/use-me";
import { parseCsv } from "@/lib/contact-csv";
import { SegmentsPanel } from "@/components/contacts/segments-panel";
import { ContactsBulkBar } from "@/components/contacts/ContactsBulkBar";
import { useT } from "@/components/i18n/LangProvider";

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
  whatsappBlock: string | null;
  owner: { fullName: string } | null;
  tags: Array<{ id: string; name: string; color: string }>;
  _count: { calls: number; conversations: number; leads: number };
  lastCall: { createdAt: string; outcome: string | null } | null;
}

const WA_BLOCK_EN: Record<string, string> = { "אין מספר טלפון תקין": "no valid phone number", "חסום לכל פנייה": "blocked from all contact" };

const CONSENT: Record<string, { label: string; en: string; tone: "good" | "bad" | "neutral" }> = { OPTED_IN: { label: "הסכמה", en: "Consent", tone: "good" }, OPTED_OUT: { label: "הוסר", en: "Opted out", tone: "bad" }, UNKNOWN: { label: "ללא הסכמה", en: "No consent", tone: "neutral" } };

export default function ContactsPage() {
  const { dial, state } = useDialer();
  const router = useRouter();
  const [waBusy, setWaBusy] = useState<string | null>(null);
  async function openWhatsApp(contactId: string) {
    setWaBusy(contactId);
    try { const r = await api.post<{ conversationId: string }>(`/api/contacts/${contactId}/whatsapp`); router.push(`/inbox/${r.conversationId}`); }
    catch (e) { toast.error((e as Error).message); }
    finally { setWaBusy(null); }
  }
  const me = useMe();
  const t = useT();
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ q: "", source: "", city: "", neverCalled: "", consent: "", tagId: "", hasOpenLead: "" });
  const [segmentId, setSegmentId] = useState<string | null>(null);
  // Selection: picked rows (kept across pages) or "all filtered results" (resolved again on the server).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allFiltered, setAllFiltered] = useState(false);
  const [lists, setLists] = useState<Array<{ id: string; name: string; segment: unknown }>>([]);
  useEffect(() => { api.get<{ lists: Array<{ id: string; name: string; segment: unknown }> }>("/api/distribution-lists").then((r) => setLists(r.lists)).catch(() => undefined); }, []);
  // A new filter / list is a new result set – a previous "all filtered" choice never carries over.
  useEffect(() => { setAllFiltered(false); setSelected(new Set()); }, [filter, segmentId]);
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
      toast.success(t("איש הקשר נוצר", "Contact created"));
      setCreateOpen(false);
      setForm({ fullName: "", phone: "", email: "", company: "", city: "", source: "", notes: "", consentStatus: "UNKNOWN", consentEvidence: "" });
      load();
      return c;
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function importCsv() {
    try {
      const [columns, ...lines] = parseCsv(csv, csv.split(/\r?\n/, 1)[0].includes("\t") ? "\t" : ",");
      if (!columns || !lines.length) return toast.error(t("יש להזין כותרות ולפחות איש קשר אחד", "Enter headers and at least one contact"));
      const header = columns.map((h) => h.trim().toLowerCase());
      const idx = (names: string[]) => header.findIndex((h) => names.includes(h));
      const iName = idx(["name", "fullname", "שם", "שם מלא"]);
      const iPhone = idx(["phone", "טלפון", "mobile", "נייד"]);
      if (iName < 0 || iPhone < 0) return toast.error(t("נדרשות עמודות שם וטלפון בשורה הראשונה", "Name and phone columns are required in the first row"));
      const iEvidence = idx(["consentevidence", "evidence", "אסמכתה"]);
      const iEmail = idx(["email", "אימייל"]), iCompany = idx(["company", "חברה"]), iCity = idx(["city", "עיר"]), iSource = idx(["source", "מקור"]), iConsent = idx(["consent", "consentstatus", "הסכמה"]);
      const rowsIn = lines.map((line, index) => {
        if (line.length !== columns.length) throw new Error(t(`מספר עמודות לא תקין בשורה ${index + 2}`, `Invalid number of columns in row ${index + 2}`));
        const c = line.map((x) => x.trim());
        const consent = iConsent >= 0 ? c[iConsent]?.toUpperCase() : undefined;
        return { consentEvidence: iEvidence >= 0 ? c[iEvidence] : undefined, fullName: c[iName] ?? "", phone: c[iPhone] ?? "", email: iEmail >= 0 ? c[iEmail] : undefined, company: iCompany >= 0 ? c[iCompany] : undefined, city: iCity >= 0 ? c[iCity] : undefined, source: iSource >= 0 ? c[iSource] : undefined, consentStatus: consent && ["OPTED_IN", "OPTED_OUT", "UNKNOWN"].includes(consent) ? consent : undefined };
      });
      const r = await api.post<{ created: number; updated: number; invalid: number; errors: Array<{ row: number; phone: string; reason: string }> }>("/api/contacts/import", { rows: rowsIn, source: "csv" });
      toast.success(t(`נוצרו ${r.created}, עודכנו ${r.updated}, לא תקינים ${r.invalid}`, `Created ${r.created}, updated ${r.updated}, invalid ${r.invalid}`));
      if (r.errors?.length) {
        toast.error(`${t("שגיאות:", "Errors:")} ${r.errors.slice(0, 5).map((e) => `${t("שורה", "Row")} ${e.row + 1} (${e.phone}): ${e.reason}`).join(" · ")}${r.errors.length > 5 ? t(` ועוד ${r.errors.length - 5}`, ` and ${r.errors.length - 5} more`) : ""}`, { duration: 15000 });
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
      toast.success(t(`הרשימה נוצרה עם ${r.added} לידים`, `List created with ${r.added} leads`));
      setListOpen(false);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const canDial = Boolean(me?.modules.telephony) && Boolean(state) && !state?.activeCall;
  const isManager = me?.user.role === "manager" || me?.user.role === "owner";

  return (
    <div className="contacts-layout">
    {isManager && <SegmentsPanel selected={segmentId} onSelect={(id) => { setPage(1); setSegmentId(id); }} total={total} />}
    <div className="p-5 space-y-4 min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{t("קהלים ואנשי קשר", "Audiences & contacts")}</h1>
        <span className="text-xs text-muted tabular">{total} {t("רשומות", "records")}</span>
        <div className="ms-auto flex flex-wrap gap-2">
          {isManager && <Link href="/audiences" className="inline-flex items-center h-8 px-3 text-xs rounded-md border border-line text-muted hover:text-text" data-testid="contacts-audiences">{t("רשימות תפוצה וייבוא", "Mailing lists & import")}</Link>}
          {isManager && <Link href="/contacts/duplicates" className="inline-flex items-center h-8 px-3 text-xs rounded-md border border-line text-muted hover:text-text">{t("כפילויות", "Duplicates")}</Link>}
          {isManager && <Link href="/api/contacts/export" prefetch={false} className="inline-flex items-center h-8 px-3 text-xs rounded-md border border-line text-muted hover:text-text">{t("ייצוא CSV", "Export CSV")}</Link>}
          {isManager && me?.modules.telephony && <Button variant="secondary" size="sm" onClick={() => { setListName(t(`רשימה מסינון · ${new Date().toLocaleDateString("he-IL")}`, `List from filter · ${new Date().toLocaleDateString("en-GB")}`)); setListOpen(true); }}>{t("רשימת חיוג מהסינון", "Dial list from filter")}</Button>}
          {isManager && <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>{t("ייבוא CSV", "Import CSV")}</Button>}
          <Button size="sm" onClick={() => setCreateOpen(true)}>{t("+ איש קשר", "+ Contact")}</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-2">
        <Input placeholder={t("חיפוש שם / טלפון / אימייל / חברה", "Search name / phone / email / company")} value={filter.q} onChange={(e) => { setPage(1); setFilter({ ...filter, q: e.target.value }); }} className="xl:col-span-2" />
        <Input placeholder={t("מקור", "Source")} value={filter.source} onChange={(e) => { setPage(1); setFilter({ ...filter, source: e.target.value }); }} />
        <Input placeholder={t("עיר", "City")} value={filter.city} onChange={(e) => { setPage(1); setFilter({ ...filter, city: e.target.value }); }} />
        <Select value={filter.consent} onChange={(e) => { setPage(1); setFilter({ ...filter, consent: e.target.value }); }}><option value="">{t("כל ההסכמות", "All consents")}</option><option value="OPTED_IN">{t("עם הסכמה", "With consent")}</option><option value="OPTED_OUT">{t("הוסרו", "Opted out")}</option><option value="UNKNOWN">{t("ללא הסכמה", "No consent")}</option></Select>
        <Select value={filter.tagId} onChange={(e) => { setPage(1); setFilter({ ...filter, tagId: e.target.value }); }}><option value="">{t("כל התגיות", "All tags")}</option>{tags.map((tg) => <option key={tg.id} value={tg.id}>{tg.name}</option>)}</Select>
        <Select value={filter.hasOpenLead || filter.neverCalled ? (filter.hasOpenLead ? "lead" : "nevercalled") : ""} onChange={(e) => { setPage(1); setFilter({ ...filter, hasOpenLead: e.target.value === "lead" ? "true" : "", neverCalled: e.target.value === "nevercalled" ? "true" : "" }); }}><option value="">{t("הכול", "All")}</option><option value="lead">{t("עם ליד פתוח", "With open lead")}</option><option value="nevercalled">{t("מעולם לא חויגו", "Never dialed")}</option></Select>
      </div>

      {loading && rows.length === 0 ? (
        <div className="flex justify-center p-10"><Spinner /></div>
      ) : rows.length === 0 ? (
        <EmptyState title={t("אין אנשי קשר", "No contacts")} hint={t("הוסף איש קשר, ייבא CSV, או קבל הודעת WhatsApp / שיחה נכנסת – כרטיס נוצר אוטומטית", "Add a contact, import a CSV, or receive a WhatsApp message / inbound call – a card is created automatically")} />
      ) : (
        <>
        <ContactsBulkBar pageIds={rows.map((r) => r.id)} selected={selected} allFiltered={allFiltered} total={total}
          filter={Object.fromEntries(Object.entries({ ...filter, segmentId: segmentId ?? "" }).filter(([, v]) => v))}
          list={segmentId ? (() => { const l = lists.find((x) => x.id === segmentId); return l ? { id: l.id, name: l.name, dynamic: l.segment !== null } : null; })() : null}
          isOwner={me?.user.role === "owner"} onSelectAll={() => setAllFiltered(true)} onClear={() => { setSelected(new Set()); setAllFiltered(false); }} onDone={load} />
        <div className="bg-panel border border-line rounded-xl overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm" data-testid="contacts-table">
            <thead className="text-xs text-muted bg-white/3">
              <tr>
                <th className="w-9 px-3"><input type="checkbox" aria-label={t("בחירת כל אנשי הקשר בעמוד", "Select all contacts on this page")} checked={allFiltered || (rows.length > 0 && rows.every((r) => selected.has(r.id)))} onChange={(e) => { setAllFiltered(false); setSelected((cur) => { const n = new Set(cur); for (const r of rows) { if (e.target.checked) n.add(r.id); else n.delete(r.id); } return n; }); }} data-testid="contacts-select-page" /></th>
                <th className="text-start px-3 h-9 font-medium">{t("שם", "Name")}</th>
                <th className="text-start px-3 font-medium">{t("טלפון", "Phone")}</th>
                <th className="text-start px-3 font-medium">{t("תגיות", "Tags")}</th>
                <th className="text-start px-3 font-medium">{t("מקור", "Source")}</th>
                <th className="text-start px-3 font-medium">{t("דיוור", "Marketing")}</th>
                <th className="text-start px-3 font-medium">{t("נציג", "Agent")}</th>
                <th className="text-start px-3 font-medium">{t("פעילות", "Activity")}</th>
                <th className="px-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((c) => (
                <tr key={c.id} className={allFiltered || selected.has(c.id) ? "bg-accent/5" : "hover:bg-white/3"}>
                  <td className="px-3"><input type="checkbox" aria-label={t(`בחירת ${c.fullName}`, `Select ${c.fullName}`)} checked={allFiltered || selected.has(c.id)} onChange={(e) => { if (allFiltered) { setAllFiltered(false); setSelected(new Set(rows.map((r) => r.id).filter((id) => id !== c.id))); return; } setSelected((cur) => { const n = new Set(cur); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; }); }} data-testid={`contact-select-${c.id}`} /></td>
                  <td className="px-3 h-11">
                    <Link href={`/contacts/${c.id}`} className="font-medium hover:underline">{c.fullName}</Link>
                    <span className="block text-[11px] text-muted truncate">{[c.company, c.city].filter(Boolean).join(" · ")}{c._count.leads ? t(` · ${c._count.leads} לידים פתוחים`, ` · ${c._count.leads} open leads`) : ""}</span>
                  </td>
                  <td className="px-3"><Phone value={formatPhone(c.phoneE164)} />{c.isDnc && <Badge tone="bad" className="ms-2">DNC</Badge>}</td>
                  <td className="px-3"><div className="flex flex-wrap gap-1">{c.tags.slice(0, 3).map((tg) => <span key={tg.id} className="px-1.5 h-5 rounded text-[11px] inline-flex items-center" style={{ background: `${tg.color}33`, color: tg.color }}>{tg.name}</span>)}{c.tags.length > 3 && <span className="text-[11px] text-muted">+{c.tags.length - 3}</span>}</div></td>
                  <td className="px-3 text-muted">{c.source ?? "—"}</td>
                  <td className="px-3">{c.suppression === "all" ? <Badge tone="bad">{t("לא ליצור קשר", "Do not contact")}</Badge> : c.suppression === "marketing" ? <Badge tone="bad">{t("הוסר מדיוור", "Unsubscribed")}</Badge> : <Badge tone={CONSENT[c.consentStatus]?.tone ?? "neutral"}>{CONSENT[c.consentStatus] ? t(CONSENT[c.consentStatus].label, CONSENT[c.consentStatus].en) : c.consentStatus}</Badge>}</td>
                  <td className="px-3 text-muted">{c.owner?.fullName ?? "—"}</td>
                  <td className="px-3 text-xs text-muted tabular">
                    {c.lastActivityAt ? relativeTime(c.lastActivityAt) : "—"}
                    <span className="block">{c._count.calls} {t("שיחות", "calls")} · {c._count.conversations} {t("התכתבויות", "conversations")}{c.lastCall?.outcome ? ` · ${OUTCOMES.find((o) => o.key === c.lastCall!.outcome)?.label ?? ""}` : ""}</span>
                  </td>
                  <td className="px-3 text-end whitespace-nowrap">
                    {me?.modules.telephony && <Button size="sm" variant="good" disabled={!canDial || c.isDnc || c.suppression === "all"} onClick={() => dial({ mode: "manual", contactId: c.id })}>{t("חייג", "Call")}</Button>}
                    {me?.modules.messaging && <Button size="sm" variant="ghost" className="ms-1" data-testid="contact-whatsapp" disabled={Boolean(c.whatsappBlock) || waBusy === c.id}
                      title={c.whatsappBlock ? t(`וואטסאפ לא זמין: ${c.whatsappBlock}`, `WhatsApp unavailable: ${WA_BLOCK_EN[c.whatsappBlock] ?? c.whatsappBlock}`) : c.suppression === "marketing" || c.isDnc ? t("הלקוח ביקש לא לקבל פניות – מענה ידני בלבד", "The customer asked not to be contacted – manual replies only") : t("פתיחת שיחת הוואטסאפ במערכת", "Open the WhatsApp conversation in the system")}
                      onClick={() => openWhatsApp(c.id)}>WhatsApp</Button>}
                    <Link href={`/contacts/${c.id}`} className="inline-flex items-center h-8 px-3 text-xs text-muted hover:text-text">{t("כרטיס", "Card")}</Link>
                    {me?.modules.messaging && c.whatsappBlock && <span className="block text-[11px] text-bad" data-testid="contact-whatsapp-reason">{t(`וואטסאפ: ${c.whatsappBlock}`, `WhatsApp: ${WA_BLOCK_EN[c.whatsappBlock] ?? c.whatsappBlock}`)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between px-3 h-10 border-t border-line text-xs text-muted">
            <span>{t(`עמוד ${page} מתוך ${Math.max(1, Math.ceil(total / 30))}`, `Page ${page} of ${Math.max(1, Math.ceil(total / 30))}`)}</span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t("הקודם", "Previous")}</Button>
              <Button size="sm" variant="ghost" disabled={page * 30 >= total} onClick={() => setPage(page + 1)}>{t("הבא", "Next")}</Button>
            </div>
          </div>
        </div>
        </>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title={t("איש קשר חדש", "New contact")} footer={<><Button variant="ghost" onClick={() => setCreateOpen(false)}>{t("ביטול", "Cancel")}</Button><Button onClick={create} disabled={!form.fullName || !form.phone}>{t("צור", "Create")}</Button></>}>
        <div className="grid md:grid-cols-2 gap-2">
          <Input label={t("שם מלא", "Full name")} value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
          <Input label={t("טלפון", "Phone")} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} ltr />
          <Input label={t("אימייל", "Email")} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} ltr />
          <Input label={t("חברה", "Company")} value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
          <Input label={t("עיר", "City")} value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
          <Input label={t("מקור", "Source")} value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} />
          <Select label={t("הסכמה לדיוור שיווקי", "Marketing consent")} value={form.consentStatus} onChange={(e) => setForm({ ...form, consentStatus: e.target.value })}><option value="UNKNOWN">{t("לא ידוע", "Unknown")}</option><option value="OPTED_IN">{t("קיימת הסכמה", "Consent given")}</option><option value="OPTED_OUT">{t("ביקש הסרה", "Requested removal")}</option></Select>
          <Input label={t("אסמכתה להסכמה", "Consent evidence")} value={form.consentEvidence} onChange={(e) => setForm({ ...form, consentEvidence: e.target.value })} hint={t("חובה לתעד הסכמה לפני דיוור שיווקי", "Consent must be documented before marketing messages")} />
          <Textarea label={t("הערות", "Notes")} rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="md:col-span-2" />
        </div>
      </Modal>
      <Modal open={importOpen} onClose={() => setImportOpen(false)} title={t("ייבוא אנשי קשר מ-CSV", "Import contacts from CSV")} footer={<><Button variant="ghost" onClick={() => setImportOpen(false)}>{t("ביטול", "Cancel")}</Button><Button onClick={importCsv} disabled={!csv.trim()}>{t("ייבא", "Import")}</Button></>} width="max-w-2xl">
        <p className="text-xs text-muted mb-2">{t("שורה ראשונה = כותרות (name/שם, phone/טלפון, email, company, city, source, consent, consentEvidence). מספרים מנורמלים; כפילויות לפי מספר מעודכנות ולא נוצרות שוב; ייבוא לעולם לא מחזיר איש קשר שהוסר לדיוור.", "First row = headers (name, phone, email, company, city, source, consent, consentEvidence). Numbers are normalized; duplicates by number are updated, not recreated; an import never resubscribes a contact who opted out.")}</p>
        <Textarea rows={12} value={csv} onChange={(e) => setCsv(e.target.value)} className="ltr font-mono text-xs" placeholder={t("name,phone,email,source,consent,consentEvidence\nישראל ישראלי,0501234567,israel@example.com,facebook,UNKNOWN,", "name,phone,email,source,consent,consentEvidence\nJohn Smith,0501234567,john@example.com,facebook,UNKNOWN,")} />
      </Modal>
      <Modal open={listOpen} onClose={() => setListOpen(false)} title={t("רשימת חיוג מהסינון הנוכחי", "Dial list from current filter")} footer={<><Button variant="ghost" onClick={() => setListOpen(false)}>{t("ביטול", "Cancel")}</Button><Button onClick={createListFromFilter} disabled={!listName}>{t("צור רשימה", "Create list")}</Button></>}>
        <Input label={t("שם הרשימה", "List name")} value={listName} onChange={(e) => setListName(e.target.value)} />
        <p className="text-xs text-muted mt-2">{t("כל אנשי הקשר שתואמים לסינון ייכנסו לרשימה. מספרים ברשימת DNC / הסרה מלאה מדולגים.", "All contacts matching the filter will be added to the list. Numbers on the DNC / full-removal list are skipped.")}</p>
      </Modal>
    </div>
    </div>
  );
}
