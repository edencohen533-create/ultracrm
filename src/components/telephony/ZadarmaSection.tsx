"use client";

/**
 * Zadarma backup account (owner only): credentials (write-only), approved caller ID, test numbers, agent extensions,
 * readiness, capabilities (supported / partial / unsupported / unverified), read-only check and a live test to an
 * approved test number. Nothing here marks Zadarma active: routing uses it only when every readiness item passes.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, ApiClientError } from "@/lib/client/api";
import { Badge, Button, Input, Select } from "@/components/ui";
import { formatDateTime } from "@/lib/client/format";
import { useT } from "@/components/i18n/LangProvider";

interface Overview {
  encryption: boolean; configured: boolean; keyHint: string | null; sandbox: boolean; webhookUrl: string | null;
  callerId: { e164: string | null; source: string | null; approvedAt: string | null } | null;
  testNumbers: string[]; maxConcurrent: number | null;
  lastCheck: { at: string; ok: boolean | null; checks: Array<{ name: string; ok: boolean; detail?: string }> | null } | null;
  liveTest: { passedAt: string | null; last: { id: string; createdAt: string; endedAt: string | null; telephonyResult: string | null; failureReason: string | null } | null };
  endpoints: Array<{ userId: string; extension: string }>;
  readiness: { ready: boolean; reason: string };
  capabilities: Array<{ key: string; status: "supported" | "partial" | "unsupported" | "unverified" | "not_implemented"; note: string }>;
}
interface User { id: string; fullName: string; isActive: boolean }

const STATUS: Record<string, [string, string, "good" | "warn" | "bad" | "neutral"]> = {
  supported: ["נתמך", "Supported", "good"], partial: ["חלקי", "Partial", "warn"], unsupported: ["לא נתמך", "Not supported", "bad"],
  unverified: ["לא אומת", "Unverified", "warn"], not_implemented: ["לא מומש", "Not implemented", "neutral"],
};
const CAP: Record<string, [string, string]> = {
  outbound: ["שיחה יוצאת", "Outbound call"], agent_audio: ["שמע לנציג", "Agent audio"], server_hangup: ["ניתוק מהמערכת", "Hang-up from the app"],
  dtmf: ["הקשת מקשים", "DTMF"], conference: ["ועידה", "Conference"], supervisor_listen_whisper: ["האזנה ולחישה", "Listen & whisper"],
  recording: ["הקלטה", "Recording"], call_events: ["אירועי שיחה", "Call events"], reconciliation_after_timeout: ["בירור אחרי timeout", "Check after timeout"], inbound: ["שיחות נכנסות", "Inbound calls"],
};

const NOTE_HE: Record<string, string> = {
  outbound: "callback: מצלצל קודם לשלוחת הנציג ב-Zadarma ואז ללקוח", agent_audio: "הווידג'ט של Zadarma (לא ממשק הטלפון שלנו)",
  server_hangup: "אין API – הנציג מנתק בווידג'ט של Zadarma", dtmf: "מהווידג'ט של הנציג בלבד", conference: "אין API (קוד 000 מהטלפון בלבד)",
  supervisor_listen_whisper: "אין API (קוד 007 מהטלפון של המנהל בלבד)", recording: "הקלטת מרכזייה, NOTIFY_RECORD, קישור הורדה ל-180 שניות",
  call_events: "לא מתועד לשיחות callback – מוכח בבדיקה החיה", reconciliation_after_timeout: "חיפוש בסטטיסטיקה (3 בקשות בדקה, ללא מזהה בקשה)",
  inbound: "רק למספרים ש-Zadarma מחזיקה; לא מנותב ב-Solina CRM",
};
const READY: Record<string, [string, string]> = {
  not_configured: ["לא הוגדרו פרטי גישה", "No credentials"], caller_id_not_approved: ["מספר יוצא לא אושר", "Caller ID not approved"],
  no_agent_extensions: ["לא הוגדרו שלוחות", "No agent extensions"], not_verified: ["בדיקת ההגדרות לא עברה", "Configuration check not passed"],
  live_test_required: ["נדרשת בדיקה חיה", "Live test required"], verified: ["מוכן", "Ready"],
};

export function ZadarmaSection() {
  const t = useT();
  const [d, setD] = useState<Overview | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ apiKey: "", apiSecret: "", sandbox: false, callerIdE164: "", callerIdSource: "", testNumbers: "", maxConcurrent: "" });
  const [ext, setExt] = useState<Record<string, string>>({});
  const [testTo, setTestTo] = useState("");
  const load = useCallback(async () => {
    try {
      const [o, u] = await Promise.all([api.get<Overview>("/api/telephony/zadarma"), api.get<{ items: User[] }>("/api/users")]);
      setD(o); setUsers(u.items.filter((x) => x.isActive));
      setForm((f) => ({ ...f, sandbox: o.sandbox, callerIdE164: o.callerId?.e164 ?? "", callerIdSource: o.callerId?.source ?? "", testNumbers: o.testNumbers.join(", "), maxConcurrent: o.maxConcurrent ? String(o.maxConcurrent) : "" }));
      setExt(Object.fromEntries(o.endpoints.map((e) => [e.userId, e.extension])));
    } catch (e) { if (!(e instanceof ApiClientError && e.status === 403)) toast.error((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (!d) return null;
  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try { await fn(); if (done) toast.success(done); await load(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  };
  const save = (approveCallerId = false) => run("save", () => api.put("/api/telephony/zadarma", {
    ...(form.apiKey ? { apiKey: form.apiKey } : {}), ...(form.apiSecret ? { apiSecret: form.apiSecret } : {}), sandbox: form.sandbox,
    callerIdE164: form.callerIdE164 || null, callerIdSource: form.callerIdSource || null, approveCallerId,
    testNumbers: form.testNumbers.split(/[,\s]+/).filter(Boolean), maxConcurrent: form.maxConcurrent ? Number(form.maxConcurrent) : null,
  }).then(() => setForm((f) => ({ ...f, apiKey: "", apiSecret: "" }))), t("נשמר", "Saved"));

  return (
    <div className="mt-5 border-t border-line pt-4 space-y-3" data-testid="zadarma-section">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold">{t("Zadarma – ספק גיבוי (חלקי)", "Zadarma – backup provider (partial)")}</h4>
        <Badge tone={d.readiness.ready ? "good" : "neutral"} data-testid="zadarma-readiness">{d.readiness.ready ? t("מוכן לשיחות אמיתיות", "Ready for real calls") : `${t("לא מוכן", "Not ready")}: ${t(...(READY[d.readiness.reason] ?? [d.readiness.reason, d.readiness.reason]))}`}</Badge>
      </div>
      <p className="text-xs text-muted">{t("Zadarma מחייגת בשיטת callback: מצלצלת קודם לשלוחת הנציג בחלון הטלפון של Zadarma ורק אחרי מענה מחייגת ללקוח. אין ניתוק, האזנה או לחישה מהמערכת, ושיחה פעילה לא עוברת בין ספקים.", "Zadarma dials by callback: it rings the agent's extension in the Zadarma phone first and dials the customer only after the agent answers. No hang-up, listening or whisper from the app, and an active call never moves between providers.")}</p>

      <table className="w-full text-xs" data-testid="zadarma-capabilities"><tbody>{d.capabilities.map((c) => { const s = STATUS[c.status]; return (
        <tr key={c.key} className="border-t border-line"><td className="p-1 w-40">{t(...(CAP[c.key] ?? [c.key, c.key]))}</td><td className="w-24"><Badge tone={s[2]}>{t(s[0], s[1])}</Badge></td><td className="text-muted">{t(NOTE_HE[c.key] ?? c.note, c.note)}</td></tr>); })}</tbody></table>

      <div className="grid md:grid-cols-3 gap-3 text-sm">
        <Input label={t(`מפתח API ${d.keyHint ? `(שמור ${d.keyHint})` : ""}`, `API key ${d.keyHint ? `(saved ${d.keyHint})` : ""}`)} value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} autoComplete="off" ltr />
        <Input type="password" label={t("סוד API (נשמר מוצפן, לא מוצג שוב)", "API secret (stored encrypted, never shown again)")} value={form.apiSecret} onChange={(e) => setForm({ ...form, apiSecret: e.target.value })} autoComplete="new-password" ltr />
        <label className="flex items-center gap-2 text-sm mt-6"><input type="checkbox" checked={form.sandbox} onChange={(e) => setForm({ ...form, sandbox: e.target.checked })} />Sandbox</label>
        <Input label={t("מספר יוצא (Caller ID)", "Caller ID")} value={form.callerIdE164} onChange={(e) => setForm({ ...form, callerIdE164: e.target.value })} ltr />
        <Select label={t("מקור המספר", "Number source")} value={form.callerIdSource} onChange={(e) => setForm({ ...form, callerIdSource: e.target.value })}>
          <option value="">—</option><option value="zadarma_number">{t("נרכש ב-Zadarma", "Bought at Zadarma")}</option><option value="verified_external">{t("מספר חיצוני שאומת ב-Zadarma", "External number verified at Zadarma")}</option>
        </Select>
        <Input type="number" label={t("שיחות במקביל לפי החבילה", "Concurrent calls (plan)")} value={form.maxConcurrent} onChange={(e) => setForm({ ...form, maxConcurrent: e.target.value })} />
        <Input label={t("מספרי בדיקה מאושרים (לא לקוחות)", "Approved test numbers (not customers)")} value={form.testNumbers} onChange={(e) => setForm({ ...form, testNumbers: e.target.value })} ltr />
      </div>
      <div className="text-xs">{d.callerId?.approvedAt ? <Badge tone="good">{t(`מספר יוצא אושר ${formatDateTime(d.callerId.approvedAt)}`, `Caller ID approved ${formatDateTime(d.callerId.approvedAt)}`)}</Badge> : <Badge tone="warn">{t("מספר יוצא לא אושר", "Caller ID not approved")}</Badge>}
        <span className="text-muted ms-2">{t("מספר של Telnyx לא יוצג דרך Zadarma אלא אם Zadarma אימתה אותו. אימות מספר יוצא לא מעביר אליו שיחות נכנסות.", "A Telnyx number is shown through Zadarma only if Zadarma verified it. Verifying a caller ID does not route inbound calls to it.")}</span></div>
      <div className="flex flex-wrap gap-2">
        <Button loading={busy === "save"} onClick={() => save(false)} data-testid="zadarma-save">{t("שמירה", "Save")}</Button>
        <Button variant="secondary" loading={busy === "save"} onClick={() => { if (confirm(t("לאשר את המספר היוצא? אשר רק אם המספר נרכש ב-Zadarma או אומת אצלם, ויש לך זכות להציג אותו.", "Approve this caller ID? Only if it was bought at Zadarma or verified there, and you have the right to present it."))) void save(true); }}>{t("שמירה ואישור מספר יוצא", "Save and approve caller ID")}</Button>
        <Button variant="secondary" loading={busy === "check"} disabled={!d.configured} onClick={() => run("check", () => api.post("/api/telephony/zadarma/check"), t("הבדיקה הסתיימה", "Check finished"))} data-testid="zadarma-check">{t("בדיקת הגדרות (קריאה בלבד)", "Check configuration (read-only)")}</Button>
      </div>
      {d.webhookUrl && <p className="text-xs">{t("כתובת Webhook להגדרה ב-Zadarma (Settings → Integrations and API → PBX call notifications, לסמן NOTIFY_OUT_START, NOTIFY_OUT_END, NOTIFY_RECORD):", "Webhook URL for Zadarma (Settings → Integrations and API → PBX call notifications; enable NOTIFY_OUT_START, NOTIFY_OUT_END, NOTIFY_RECORD):")} <code className="ltr break-all">{d.webhookUrl}</code></p>}
      {d.lastCheck && <ul className="text-xs">{(d.lastCheck.checks ?? []).map((c) => <li key={c.name} className={c.ok ? "text-muted" : "text-bad"}>{c.ok ? "✓" : "✗"} {c.name}{c.detail ? ` – ${c.detail}` : ""}</li>)}<li className="text-muted">{formatDateTime(d.lastCheck.at)}</li></ul>}

      <div>
        <h5 className="text-xs font-semibold">{t("שלוחות Zadarma לנציגים", "Zadarma extensions per agent")}</h5>
        <div className="grid md:grid-cols-3 gap-2 mt-1">{users.map((u) => <Input key={u.id} label={u.fullName} value={ext[u.id] ?? ""} onChange={(e) => setExt({ ...ext, [u.id]: e.target.value })} placeholder="101" ltr />)}</div>
        <Button size="sm" variant="secondary" className="mt-2" loading={busy === "ext"} onClick={() => run("ext", () => api.put("/api/telephony/zadarma/extensions", { items: users.map((u) => ({ userId: u.id, extension: ext[u.id]?.trim() || null })) }), t("נשמר", "Saved"))}>{t("שמירת שלוחות", "Save extensions")}</Button>
      </div>

      <div data-testid="zadarma-live-test">
        <h5 className="text-xs font-semibold">{t("בדיקה חיה (שיחה בתשלום למספר בדיקה מאושר בלבד)", "Live test (paid call to an approved test number only)")}</h5>
        <div className="flex flex-wrap items-end gap-2 mt-1">
          <Select value={testTo} onChange={(e) => setTestTo(e.target.value)}><option value="">{t("בחר מספר בדיקה", "Choose a test number")}</option>{d.testNumbers.map((n) => <option key={n} value={n}>{n}</option>)}</Select>
          <Button size="sm" variant="secondary" disabled={!testTo} loading={busy === "live"} onClick={() => { if (confirm(t("תתבצע שיחה אמיתית בתשלום דרך Zadarma: קודם לשלוחה שלך, ואז למספר הבדיקה. להמשיך?", "A real paid call will be placed through Zadarma: first to your extension, then to the test number. Continue?"))) void run("live", () => api.post("/api/telephony/zadarma/live-test", { to: testTo }), t("השיחה נשלחה – ענה בשלוחה שלך", "Call requested – answer on your extension")); }}>{t("הפעלת בדיקה חיה", "Run live test")}</Button>
        </div>
        <p className="text-xs mt-1">{d.liveTest.passedAt ? <Badge tone="good">{t(`עברה ${formatDateTime(d.liveTest.passedAt)}`, `Passed ${formatDateTime(d.liveTest.passedAt)}`)}</Badge> : <Badge tone="warn">{t("לא עברה – Zadarma לא תקבל שיחות אמיתיות עד שתעבור", "Not passed – Zadarma gets no real calls until it passes")}</Badge>}
          {d.liveTest.last && <span className="text-muted ms-2">{t("בדיקה אחרונה:", "Last test:")} {formatDateTime(d.liveTest.last.createdAt)} · {d.liveTest.last.endedAt ? (d.liveTest.last.telephonyResult ?? d.liveTest.last.failureReason) : t("בתהליך", "in progress")}</span>}</p>
      </div>
      <p className="text-xs text-muted">{t("מחירים (zadarma.com/en/tariffs/calls/israel, נבדק 29.09.2026): לנייח $0.024–0.04 לדקה, לנייד $0.04–0.12 לדקה לפי מסלול ומספר מזהה. חיוב לפי חשבון Zadarma של העסק.", "Prices (zadarma.com/en/tariffs/calls/israel, checked 2026-09-29): landline $0.024–0.04/min, mobile $0.04–0.12/min depending on plan and caller ID. Billed to the business's own Zadarma account.")}</p>
    </div>
  );
}
