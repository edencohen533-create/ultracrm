"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useDialer } from "@/components/telephony/DialerProvider";
import { Badge, Button, ErrorState, Modal, Spinner } from "@/components/ui";
import { SessionControls } from "./SessionControls";
import { LeadQueue } from "./LeadQueue";
import { LeadCard } from "./LeadCard";
import { CallPanel } from "./CallPanel";
import { OutcomePanel } from "./OutcomePanel";
import { CoachCard } from "@/components/coach/CoachCard";
import { useHotkeys } from "./useHotkeys";
import { callElapsed, useTicker } from "@/components/telephony/CallBar";
import { CALL_STATUS_LABEL, formatDuration, formatPhone } from "@/lib/client/format";
import { Kbd, cx } from "@/components/ui";
import type { CallDto, OutcomeKey } from "@/lib/client/types";
import { DealCloseModal } from "@/components/leads/DealCloseModal";

const SKIP_REASONS = ["לא זמן מתאים", "פרטים חסרים", "כבר דיברתי איתו", "ליד לא רלוונטי", "אחר"];

/**
 * `minimal` (the /dialer screen): only the lead's details – a one-line session strip, a slim call strip (status,
 * hangup / dial / skip) and the lead card with its notes, script, history and outcome form. No queue list, no keypad,
 * no connection panel, no recent calls.
 */
export function DialerWorkspace({ embedded = false, compact = false, minimal = false }: { embedded?: boolean; compact?: boolean; minimal?: boolean } = {}) {
  const d = useDialer();
  const { state, loading, error, refresh, dial, hangup, skipLead, saveOutcome, busy, sessionTakenOver, countdown, cancelCountdown, sessionSummary, dismissSummary } = d;
  const [note, setNote] = useState("");
  const [skipOpen, setSkipOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [fullWrapUp, setFullWrapUp] = useState(false);
  /** A sale in the dialer opens the "עסקה נסגרה" popup (products, value, renewal date) before moving on. */
  const [sale, setSale] = useState<{ contactId: string; name: string; then: "next" | "none" } | null>(null);

  const session = state?.session;
  const lead = state?.lead ?? null;
  const call = state?.activeCall ?? null;
  const wrapUp = state?.wrapUpCall ?? null;
  const focusContactId = call?.contactId ?? wrapUp?.contactId ?? lead?.contactId ?? null;
  const previewMode = session?.mode === "preview";
  const canDialLead = Boolean(lead && lead.status === "locked" && !call && !wrapUp && !sessionTakenOver && session?.status === "active");

  useEffect(() => {
    setRefreshKey((k) => k + 1);
  }, [call?.id, call?.endedAt, wrapUp?.id, lead?.id]);

  const dialLead = useCallback(async () => {
    if (!lead || !canDialLead) return;
    cancelCountdown();
    await dial({ mode: session?.mode ?? "manual", leadId: lead.id, lockToken: lead.lockToken ?? undefined });
  }, [lead, canDialLead, dial, session?.mode, cancelCountdown]);

  /** "חייג לליד" when no lead is locked yet (power countdown / preview before the next lead): pull the next one and dial now. */
  const dialNext = useCallback(async () => {
    if (call || wrapUp || !session || session.status !== "active" || sessionTakenOver) return;
    cancelCountdown();
    const next = lead && lead.status === "locked" ? lead : await d.nextLead();
    if (!next) { toast.info("אין כרגע לידים זמינים לחיוג בתור"); return; }
    await dial({ mode: session.mode ?? "manual", leadId: next.id, lockToken: next.lockToken ?? undefined });
  }, [call, wrapUp, session, sessionTakenOver, cancelCountdown, lead, d, dial]);

  const dialManual = useCallback(
    async (phone: string) => {
      if (call) return toast.error("יש שיחה פעילה");
      if (wrapUp) return toast.error("תעד את השיחה הקודמת קודם");
      await dial({ mode: "manual", phone });
    },
    [call, wrapUp, dial],
  );

  useEffect(() => { setFullWrapUp(false); }, [wrapUp?.id]);
  /** "המשך לליד הבא": save the (auto / quick) outcome with the typed note and dial the next lead now. */
  const continueNext = useCallback(async (outcome: OutcomeKey, afterDeal = false) => {
    if (!wrapUp) return;
    if (outcome === "sale" && wrapUp.contactId && !afterDeal) { setSale({ contactId: wrapUp.contactId, name: formatPhone(wrapUp.toE164), then: "next" }); return; }
    try {
      await d.continueToNext(wrapUp.id, outcome, { note });
      setNote("");
      if (wrapUp.contactId) { try { localStorage.removeItem(`dialer.note.${wrapUp.contactId}`); } catch { /* ignore */ } }
    } catch { /* toast shown by provider */ }
  }, [wrapUp, d, note]);

  const onSave = useCallback(
    async (outcome: OutcomeKey, callbackAt?: Date, callbackUserId?: string) => {
      if (!wrapUp) return;
      try {
        await saveOutcome(wrapUp.id, outcome, { note, callbackAt, callbackUserId });
        setNote("");
        if (wrapUp.contactId) {
          try {
            localStorage.removeItem(`dialer.note.${wrapUp.contactId}`);
          } catch {
            /* ignore */
          }
        }
        toast.success("התוצאה נשמרה");
        if (outcome === "sale" && wrapUp.contactId) setSale({ contactId: wrapUp.contactId, name: formatPhone(wrapUp.toE164), then: "none" });
      } catch {
        /* toast shown by provider */
      }
    },
    [wrapUp, saveOutcome, note],
  );

  const hotkeys = useMemo(
    () => ({
      d: () => canDialLead && dialLead(),
      h: () => call && hangup(),
      m: () => call?.status === "answered" && d.phone.toggleMute(),
      s: () => previewMode && canDialLead && setSkipOpen(true),
      Escape: () => countdown && cancelCountdown(),
    }),
    [canDialLead, dialLead, call, hangup, d.phone, previewMode, countdown, cancelCountdown],
  );
  useHotkeys(hotkeys, !skipOpen);

  if (loading && !state) return <div className="flex items-center justify-center h-[60vh]"><Spinner /></div>;
  if (error && !state) return <ErrorState message={error} retry={refresh} />;

  return (
    <div className={embedded ? "flex flex-col h-full min-h-0" : "flex flex-col h-screen min-h-0"}>
      <header className="px-4 py-3 border-b border-line bg-panel/60 shrink-0">
        {!minimal && <div className="flex items-center gap-3 mb-2">
          <h1 className="text-base font-semibold">{embedded ? "חייגן פעיל" : "מסך עבודה"}</h1>
          {state?.telephony.simulation && <Badge tone="warn">מצב הדמיה – השיחות אינן אמיתיות</Badge>}
          {error && <Badge tone="bad">אין חיבור לשרת – מנסה שוב</Badge>}
        </div>}
        <SessionControls />
        {sessionTakenOver && (
          <div className="mt-2 text-xs bg-bad/10 text-bad rounded-md p-2 flex items-center justify-between">
            <span>סשן החיוג פעיל בלשונית אחרת. לשונית זו במצב צפייה בלבד.</span>
            <Button size="sm" variant="danger" onClick={() => session && d.startSession(session.mode, session.listId ?? undefined, session.countdownSeconds)}>
              העבר לכאן
            </Button>
          </div>
        )}
      </header>

      <div className={minimal ? "flex-1 min-h-0 overflow-y-auto flex flex-col" : compact ? "compact-dialer-content flex-1 min-h-0 overflow-y-auto flex flex-col" : "flex-1 min-h-0 grid grid-cols-[300px_minmax(0,1fr)_320px]"}>
        {/* Queue (right in RTL) */}
        <aside className={compact || minimal ? "hidden" : "border-s-0 border-e border-line bg-panel min-h-0"}>
          {session?.listId ? (
            <LeadQueue listId={session.listId} currentLeadId={lead?.id} refreshKey={refreshKey} />
          ) : (
            <div className="p-4 text-xs text-muted">{session ? "סשן ידני – אין תור. חייג מהלוח או מכרטיס ליד." : "אין סשן פעיל. תעד את השיחה כדי לחזור לרשימת הלידים."}</div>
          )}
        </aside>

        {/* Active lead */}
        <section className={minimal ? "flex-1 min-h-0 flex flex-col" : compact ? "min-h-[330px] flex flex-col order-2 shrink-0" : "min-h-0 flex flex-col"}>
          {minimal && <CallStrip onContinueAuto={wrapUp && !wrapUp.answeredAt && !fullWrapUp && session?.status === "active" && session.mode !== "manual" ? () => continueNext(wrapUp.telephonyResult === "busy" ? "busy" : "no_answer") : undefined} canDialLead={canDialLead} onDialLead={dialLead} onDialNext={dialNext} canDialNext={Boolean(session && session.status === "active" && session.mode !== "manual" && !call && !wrapUp && !sessionTakenOver)} blockedReason={!session ? "אין סשן חיוג פעיל – התחל חייגן מהתור או חייג מכרטיס ליד" : session.status !== "active" ? "הסשן מושהה – לחץ המשך" : sessionTakenOver ? "הסשן פעיל בלשונית אחרת" : wrapUp ? (wrapUp.answeredAt ? "השיחה הסתיימה – בחר תוצאה למטה והמשך" : "השיחה הסתיימה")  : session.mode === "manual" ? "סשן ידני – חייג מכרטיס ליד או מהלוח" : null} onSkip={previewMode ? () => setSkipOpen(true) : undefined} />}
          {call && (
            <div className="p-3 border-b border-line shrink-0">
              <CoachCard callId={call.id} answered={call.status === "answered"} simulation={Boolean(state?.telephony.simulation)} />
            </div>
          )}
          <div className="flex-1 min-h-0">
            <LeadCard
              contactId={focusContactId}
              lead={lead && lead.contactId === focusContactId ? lead : null}
              script={state?.script ?? null}
              draft={state?.draft ?? null}
              noteValue={note}
              onNoteChange={setNote}
              canEdit
              refreshKey={refreshKey}
            />
          </div>
          {sale && <DealCloseModal contactId={sale.contactId} name={sale.name} onClose={() => setSale(null)} onDone={() => { const then = sale.then; setSale(null); if (then === "next") void continueNext("sale", true); }} />}
          {wrapUp && !call && (minimal && !fullWrapUp
            ? <NextBar call={wrapUp} canContinue={Boolean(session && session.status === "active" && session.mode !== "manual" && !sessionTakenOver)} busy={busy === "outcome" || busy === "next" || busy === "dial"} onContinue={continueNext} onFull={() => setFullWrapUp(true)} />
            : <OutcomePanel call={wrapUp} note={note} onSave={onSave} saving={busy === "outcome"} />)}
        </section>

        {/* Call panel (left in RTL) */}
        <aside className={minimal ? "hidden" : compact ? "bg-panel order-1 shrink-0" : "border-s border-line bg-panel min-h-0"}>
          <CallPanel onDialManual={dialManual} canDialLead={canDialLead} onDialLead={dialLead} onSkip={previewMode ? () => setSkipOpen(true) : undefined} />
        </aside>
      </div>

      <Modal open={Boolean(sessionSummary)} onClose={dismissSummary} title={sessionSummary?.reason === "list_empty" ? "הרשימה נגמרה – סיכום סשן" : "סיכום סשן"} footer={<Button onClick={dismissSummary}>סגור</Button>}>
        {sessionSummary && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-panel-2 rounded-lg p-3 text-center"><p className="text-2xl font-semibold tabular">{sessionSummary.dials}</p><p className="text-xs text-muted">חיוגים</p></div>
              <div className="bg-panel-2 rounded-lg p-3 text-center"><p className="text-2xl font-semibold tabular text-good">{sessionSummary.connected}</p><p className="text-xs text-muted">נענו</p></div>
              <div className="bg-panel-2 rounded-lg p-3 text-center"><p className="text-2xl font-semibold tabular">{Math.round(sessionSummary.talkSeconds / 60)}</p><p className="text-xs text-muted">דקות שיחה</p></div>
            </div>
            {sessionSummary.outcomes.length > 0 && (
              <ul className="divide-y divide-line">{sessionSummary.outcomes.map((o) => <li key={o.key} className="flex justify-between py-1"><span>{o.label}</span><span className="tabular">{o.count}</span></li>)}</ul>
            )}
            <p className="text-xs text-muted">זמן תיעוד ממוצע: {sessionSummary.avgWrapUpSeconds} שנ׳</p>
            {sessionSummary.queue && (
              <p className="text-xs text-muted">
                נשארו ברשימה: {sessionSummary.queue.total} · ממתינים לחלון/ניסיון חוזר: {sessionSummary.queue.unavailable.notDueYet as number} · הושלמו: {sessionSummary.queue.unavailable.completed as number} · מוצו: {sessionSummary.queue.unavailable.exhausted as number}
              </p>
            )}
          </div>
        )}
      </Modal>

      <Modal open={skipOpen} onClose={() => setSkipOpen(false)} title="דילוג על ליד – בחר סיבה">
        <div className="grid grid-cols-1 gap-2">
          {SKIP_REASONS.map((r) => (
            <Button key={r} variant="secondary" onClick={async () => { setSkipOpen(false); await skipLead(r); }}>
              {r}
            </Button>
          ))}
        </div>
      </Modal>
    </div>
  );
}

/** Slim call controls for the minimal screen: what is happening + hang up / dial / skip. Everything else lives in the lead card. */
function CallStrip({ canDialLead, onDialLead, onDialNext, canDialNext, blockedReason, onSkip, onContinueAuto }: { canDialLead: boolean; onDialLead: () => void; onDialNext: () => void; canDialNext: boolean; blockedReason: string | null; onSkip?: () => void; onContinueAuto?: () => void }) {
  const { state, phone, hangup, busy, countdown, acceptInbound, rejectInbound } = useDialer();
  const call = state?.activeCall ?? null;
  useTicker(Boolean(call));
  const answered = call?.status === "answered";
  const inProgress = Boolean(call && !call.endedAt);
  const inboundRinging = Boolean(call && call.direction === "inbound" && !call.answeredAt && !call.endedAt);
  const connOk = phone.status === "ready" || phone.status === "simulation";
  return (
    <div className={cx("call-strip", answered && "answered")} data-testid="call-strip">
      <div className="call-strip-status">
        {call ? (
          <><span className={cx("dot", answered ? "on" : "wait")} /><span>{CALL_STATUS_LABEL[call.status] ?? call.status}</span><span className="tabular" dir="ltr">{formatPhone(call.toE164)}</span>{(answered || call.endedAt) && <b className="tabular">{formatDuration(call.endedAt ? (call.talkSeconds ?? 0) : callElapsed(call))}</b>}</>
        ) : countdown ? (
          <span>חיוג אוטומטי בעוד <b className="tabular text-warn">{countdown.secondsLeft}</b></span>
        ) : (
          <span className="text-muted">{blockedReason ?? "אין שיחה פעילה"}</span>
        )}
        {phone.status === "simulation" && <span className="text-muted text-xs">· הדמיה</span>}
      </div>
      <div className="call-strip-actions">
        {inboundRinging ? (
          <><Button variant="good" onClick={acceptInbound} loading={busy === "accept"}>קבל</Button><Button variant="danger" onClick={rejectInbound} loading={busy === "reject"}>דחה</Button></>
        ) : inProgress ? (
          <><Button variant={phone.muted ? "warn" : "secondary"} onClick={phone.toggleMute} disabled={!answered || phone.status === "simulation"}>{phone.muted ? "בטל השתקה" : "השתק"} <Kbd>M</Kbd></Button><Button variant="danger" onClick={hangup} loading={busy === "hangup"}>נתק <Kbd>H</Kbd></Button></>
        ) : onContinueAuto ? (
          <Button variant="good" onClick={onContinueAuto} loading={busy === "outcome" || busy === "next" || busy === "dial"} data-testid="strip-continue">המשך לליד הבא ›</Button>
        ) : (
          <>{onSkip && <Button variant="secondary" onClick={onSkip} disabled={!canDialLead}>דלג <Kbd>S</Kbd></Button>}<Button variant="good" onClick={canDialLead ? onDialLead : onDialNext} disabled={(!canDialLead && !canDialNext) || !connOk || busy === "dial" || busy === "next"} loading={busy === "dial" || busy === "next"} title={blockedReason ?? undefined} data-testid="strip-dial-lead">חייג לליד <Kbd>D</Kbd></Button></>
        )}
      </div>
    </div>
  );
}

/**
 * After a hang-up (minimal dialer screen): no wrap-up screen – one big "המשך לליד הבא".
 * Unanswered calls are documented automatically from the provider result (אין מענה / תפוס); for an answered call the
 * agent taps the result first. The full documentation form (callback time, contact edits…) stays one click away.
 */
function NextBar({ call, canContinue, busy, onContinue, onFull }: { call: CallDto; canContinue: boolean; busy: boolean; onContinue: (o: OutcomeKey) => void; onFull: () => void }) {
  const answered = Boolean(call.answeredAt);
  const auto: OutcomeKey = call.telephonyResult === "busy" ? "busy" : "no_answer";
  const [pick, setPick] = useState<OutcomeKey | null>(answered ? null : auto);
  const quick: Array<[OutcomeKey, string]> = [["answered_interested", "מעוניין"], ["answered_not_interested", "לא מעוניין"], ["sale", "בוצעה מכירה"]];
  return (
    <div className="next-bar" data-testid="next-bar">
      <div className="next-bar-info">
        <b>השיחה הסתיימה</b>
        {answered ? <span>בחר תוצאה:</span> : <span>נרשם אוטומטית: <b>{auto === "busy" ? "תפוס" : "אין מענה"}</b></span>}
        {answered && <div className="next-bar-chips">{quick.map(([k, label]) => <button key={k} type="button" aria-pressed={pick === k} onClick={() => setPick(k)} data-testid={`next-quick-${k}`}>{label}</button>)}</div>}
      </div>
      <div className="next-bar-actions">
        <button type="button" className="next-bar-full" onClick={onFull} data-testid="next-full">תיעוד מלא / לחזור בהמשך</button>
        <Button variant="good" size="lg" disabled={!pick || busy} loading={busy} onClick={() => pick && onContinue(pick)} data-testid="next-continue">{canContinue ? "המשך לליד הבא ›" : "שמור"}</Button>
      </div>
    </div>
  );
}
