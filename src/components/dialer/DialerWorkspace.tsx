"use client";

import { PaymentButton } from "./PaymentModal";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useDialer } from "@/components/telephony/DialerProvider";
import { Badge, Button, ErrorState, Modal, Spinner } from "@/components/ui";
import { SessionControls } from "./SessionControls";
import { LeadQueue } from "./LeadQueue";
import { LeadCard } from "./LeadCard";
import { NoLeadsPanel } from "./NoLeadsPanel";
import { DueElsewhereBanner } from "./DueElsewhereBanner";
import { CallPanel } from "./CallPanel";
import { OutcomePanel } from "./OutcomePanel";
import { FollowUpFields, pickReady, useWrapUpStatuses, type WrapUpPick } from "./WrapUpStatus";
import { CoachCard } from "@/components/coach/CoachCard";
import { useHotkeys } from "./useHotkeys";
import { callElapsed, useTicker } from "@/components/telephony/CallBar";
import { CALL_STATUS_LABEL, formatDuration, formatPhone } from "@/lib/client/format";
import { Kbd, cx } from "@/components/ui";
import type { CallDto, OutcomeKey } from "@/lib/client/types";
import { DealCloseModal } from "@/components/leads/DealCloseModal";
import { PostCallWhatsApp } from "./PostCallWhatsApp";
import { useT } from "@/components/i18n/LangProvider";

/** [value sent to the server (Hebrew, unchanged), English display label] */
const SKIP_REASONS: Array<[string, string]> = [["לא זמן מתאים", "Bad timing"], ["פרטים חסרים", "Missing details"], ["כבר דיברתי איתו", "Already spoke with them"], ["ליד לא רלוונטי", "Irrelevant lead"], ["אחר", "Other"]];

/**
 * `minimal` (the /dialer screen): only the lead's details – a one-line session strip, a slim call strip (status,
 * hangup / dial / skip) and the lead card with its notes, script, history and outcome form. No queue list, no keypad,
 * no connection panel, no recent calls.
 */
export function DialerWorkspace({ embedded = false, compact = false, minimal = false }: { embedded?: boolean; compact?: boolean; minimal?: boolean } = {}) {
  const t = useT();
  const d = useDialer();
  const { state, loading, error, refresh, dial, hangup, skipLead, saveOutcome, busy, sessionTakenOver, countdown, cancelCountdown, sessionSummary, dismissSummary } = d;
  const [note, setNote] = useState("");
  const [skipOpen, setSkipOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [fullWrapUp, setFullWrapUp] = useState(false);
  /** A sale in the dialer opens the "עסקה נסגרה" popup (products, value, renewal date) before moving on. */
  const [sale, setSale] = useState<{ contactId: string; name: string; then: "next" | "none"; pick?: WrapUpPick } | null>(null);

  const session = state?.session;
  const lead = state?.lead ?? null;
  const call = state?.activeCall ?? null;
  const wrapUp = state?.wrapUpCall ?? null;
  const focusContactId = call?.contactId ?? wrapUp?.contactId ?? lead?.contactId ?? null;
  const previewMode = session?.mode === "preview";
  // A call waiting for a result never blocks the next one: the server closes it automatically (AI documents it).
  const canDialLead = Boolean(lead && lead.status === "locked" && !call && !sessionTakenOver && session?.status === "active");

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
    if (call || !session || session.status !== "active" || sessionTakenOver) return;
    cancelCountdown();
    const next = lead && lead.status === "locked" ? lead : await d.nextLead();
    if (!next) return; // the "אין לידים זמינים" panel explains why (loaded by nextLead)
    await dial({ mode: session.mode ?? "manual", leadId: next.id, lockToken: next.lockToken ?? undefined });
  }, [call, session, sessionTakenOver, cancelCountdown, lead, d, dial]);

  const dialManual = useCallback(
    async (phone: string) => {
      if (call) return toast.error(t("יש שיחה פעילה", "A call is in progress"));
      await dial({ mode: "manual", phone });
    },
    [call, dial, t],
  );

  useEffect(() => { setFullWrapUp(false); }, [wrapUp?.id]);
  /** "המשך לליד הבא": save the (auto / quick) outcome with the typed note and dial the next lead now. */
  const continueNext = useCallback(async (choice: OutcomeKey | WrapUpPick, afterDeal = false) => {
    if (!wrapUp) return;
    const pick: WrapUpPick = typeof choice === "string" ? { outcome: choice } : choice;
    // A sale (by the status's meaning) opens the deal form first, then continues.
    const isSale = pick.kind === "converted" || pick.outcome === "sale";
    if (isSale && wrapUp.contactId && !afterDeal) { setSale({ contactId: wrapUp.contactId, name: formatPhone(wrapUp.toE164), then: "next", pick }); return; }
    try {
      await d.continueToNext(wrapUp.id, pick.statusId ? null : pick.outcome ?? null, { note, statusId: pick.statusId, followUp: pick.followUp, callbackUserId: pick.callbackUserId });
      setNote("");
      if (wrapUp.contactId) { try { localStorage.removeItem(`dialer.note.${wrapUp.contactId}`); } catch { /* ignore */ } }
    } catch { /* toast shown by provider */ }
  }, [wrapUp, d, note]);

  const onSave = useCallback(
    async (pick: WrapUpPick) => {
      if (!wrapUp) return;
      try {
        await saveOutcome(wrapUp.id, pick.statusId ? null : pick.outcome ?? null, { note, statusId: pick.statusId, followUp: pick.followUp, callbackUserId: pick.callbackUserId });
        setNote("");
        if (wrapUp.contactId) {
          try {
            localStorage.removeItem(`dialer.note.${wrapUp.contactId}`);
          } catch {
            /* ignore */
          }
        }
        toast.success(t("התוצאה נשמרה", "Outcome saved"));
        if ((pick.kind === "converted" || pick.outcome === "sale") && wrapUp.contactId) setSale({ contactId: wrapUp.contactId, name: formatPhone(wrapUp.toE164), then: "none" });
      } catch {
        /* toast shown by provider */
      }
    },
    [wrapUp, saveOutcome, note, t],
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
    <div className={embedded ? "flex flex-col h-full min-h-0" : "flex flex-col h-dvh min-h-0"}>
      <header className="px-4 py-3 border-b border-line bg-panel/60 shrink-0">
        {!minimal && <div className="flex items-center gap-3 mb-2">
          <h1 className="text-base font-semibold">{embedded ? t("חייגן פעיל", "Active dialer") : t("מסך עבודה", "Workspace")}</h1>
          {state?.telephony.simulation && <Badge tone="warn">{t("מצב הדמיה – השיחות אינן אמיתיות", "Simulation mode – calls are not real")}</Badge>}
          {error && <Badge tone="bad">{t("אין חיבור לשרת – מנסה שוב", "No server connection – retrying")}</Badge>}
        </div>}
        <SessionControls />
        <DueElsewhereBanner />
        {sessionTakenOver && (
          <div className="mt-2 text-xs bg-bad/10 text-bad rounded-md p-2 flex items-center justify-between">
            <span>{t("סשן החיוג פעיל בלשונית אחרת. לשונית זו במצב צפייה בלבד.", "The dial session is active in another tab. This tab is view-only.")}</span>
            <Button size="sm" variant="danger" onClick={() => session && d.startSession(session.mode, session.listId ?? undefined, session.countdownSeconds)}>
              {t("העבר לכאן", "Move here")}
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
            <div className="p-4 text-xs text-muted">{session ? t("סשן ידני – אין תור. חייג מהלוח או מכרטיס ליד.", "Manual session – no queue. Dial from the keypad or a lead card.") : t("אין סשן פעיל. אפשר להתחיל סשן או לחייג ידנית.", "No active session. Start a session or dial manually.")}</div>
          )}
        </aside>

        {/* Active lead */}
        <section className={minimal ? "flex-1 min-h-0 flex flex-col" : compact ? "min-h-[330px] flex flex-col order-2 shrink-0" : "min-h-0 flex flex-col"}>
          {minimal && <CallStrip onContinueAuto={wrapUp && !wrapUp.answeredAt && !fullWrapUp && session?.status === "active" && session.mode !== "manual" ? () => continueNext(wrapUp.telephonyResult === "busy" ? "busy" : "no_answer") : undefined} canDialLead={canDialLead} onDialLead={dialLead} onDialNext={dialNext} canDialNext={Boolean(session && session.status === "active" && session.mode !== "manual" && !call && !wrapUp && !sessionTakenOver)} blockedReason={!session ? t("אין סשן חיוג פעיל – התחל חייגן מהתור או חייג מכרטיס ליד", "No active dial session – start the dialer from the queue or dial from a lead card") : session.status !== "active" ? t("הסשן מושהה – לחץ המשך", "Session paused – click Resume") : sessionTakenOver ? t("הסשן פעיל בלשונית אחרת", "Session is active in another tab") : wrapUp ? (wrapUp.answeredAt ? t("השיחה הסתיימה – בחר תוצאה למטה והמשך", "Call ended – choose an outcome below and continue") : t("השיחה הסתיימה", "Call ended"))  : session.mode === "manual" ? t("סשן ידני – חייג מכרטיס ליד או מהלוח", "Manual session – dial from a lead card or the keypad") : null} onSkip={previewMode ? () => setSkipOpen(true) : undefined} />}
          {(call?.contactId || wrapUp?.contactId) && (
            <div className="flex justify-end px-3 pt-2" data-testid="dialer-payment"><PaymentButton contactId={call?.contactId ?? wrapUp?.contactId} callId={call?.id ?? wrapUp?.id} /></div>
          )}
          {call && (
            <div className="p-3 border-b border-line shrink-0">
              <CoachCard callId={call.id} answered={call.status === "answered"} simulation={Boolean(state?.telephony.simulation)} />
            </div>
          )}
          {d.emptyState && !call && !wrapUp && !(lead && lead.status === "locked") && <NoLeadsPanel />}
          <div className={d.emptyState && !call && !wrapUp && !(lead && lead.status === "locked") ? "hidden" : "flex-1 min-h-0"}>
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
          {sale && <DealCloseModal contactId={sale.contactId} name={sale.name} onClose={() => setSale(null)} onDone={() => { const then = sale.then; setSale(null); if (then === "next") void continueNext(sale.pick ?? "sale", true); }} />}
          {wrapUp && !call && (minimal && !fullWrapUp
            ? <NextBar call={wrapUp} canContinue={Boolean(session && session.status === "active" && session.mode !== "manual" && !sessionTakenOver)} busy={busy === "outcome" || busy === "next" || busy === "dial"} onContinue={continueNext} onFull={() => setFullWrapUp(true)} />
            
            : <><p className="px-4 pt-2 text-xs text-muted" data-testid="outcome-optional">{t("בחירת תוצאה אינה חובה: השיחה מתועדת אוטומטית על ידי AI, ואם תמשיכו בלי לבחור היא תיסגר לפי מה שדווח מהספק. בחרו תוצאה כשצריך פולואפ, מכירה או חסימה.", "Choosing a result is optional: the call is documented automatically by AI, and if you move on without choosing it is closed according to what the provider reported. Choose a result when you need a follow-up, a sale or a block.")}</p><div className="px-4 pt-2"><PostCallWhatsApp callId={wrapUp.id} /></div><OutcomePanel call={wrapUp} note={note} onSave={onSave} saving={busy === "outcome"} /></>)}
        </section>

        {/* Call panel (left in RTL) */}
        <aside className={minimal ? "hidden" : compact ? "bg-panel order-1 shrink-0" : "border-s border-line bg-panel min-h-0"}>
          <CallPanel onDialManual={dialManual} canDialLead={canDialLead} onDialLead={dialLead} onSkip={previewMode ? () => setSkipOpen(true) : undefined} />
        </aside>
      </div>

      <Modal open={Boolean(sessionSummary)} onClose={dismissSummary} title={sessionSummary?.reason === "list_empty" ? t("הרשימה נגמרה – סיכום סשן", "List finished – session summary") : t("סיכום סשן", "Session summary")} footer={<Button onClick={dismissSummary}>{t("סגור", "Close")}</Button>}>
        {sessionSummary && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-panel-2 rounded-lg p-3 text-center"><p className="text-2xl font-semibold tabular">{sessionSummary.dials}</p><p className="text-xs text-muted">{t("חיוגים", "Dials")}</p></div>
              <div className="bg-panel-2 rounded-lg p-3 text-center"><p className="text-2xl font-semibold tabular text-good">{sessionSummary.connected}</p><p className="text-xs text-muted">{t("נענו", "Answered")}</p></div>
              <div className="bg-panel-2 rounded-lg p-3 text-center"><p className="text-2xl font-semibold tabular">{Math.round(sessionSummary.talkSeconds / 60)}</p><p className="text-xs text-muted">{t("דקות שיחה", "Talk minutes")}</p></div>
            </div>
            {sessionSummary.outcomes.length > 0 && (
              <ul className="divide-y divide-line">{sessionSummary.outcomes.map((o) => <li key={o.key} className="flex justify-between py-1"><span>{o.label}</span><span className="tabular">{o.count}</span></li>)}</ul>
            )}
            <p className="text-xs text-muted">{t(`זמן תיעוד ממוצע: ${sessionSummary.avgWrapUpSeconds} שנ׳`, `Average wrap-up time: ${sessionSummary.avgWrapUpSeconds}s`)}</p>
            {sessionSummary.queue && (
              <p className="text-xs text-muted">
                {t("נשארו ברשימה:", "Left in list:")} {sessionSummary.queue.total} · {t("ממתינים לחלון/ניסיון חוזר:", "Waiting for window/retry:")} {sessionSummary.queue.unavailable.notDueYet as number} · {t("הושלמו:", "Completed:")} {sessionSummary.queue.unavailable.completed as number} · {t("מוצו:", "Exhausted:")} {sessionSummary.queue.unavailable.exhausted as number}
              </p>
            )}
          </div>
        )}
      </Modal>

      <Modal open={skipOpen} onClose={() => setSkipOpen(false)} title={t("דילוג על ליד – בחר סיבה", "Skip lead – choose a reason")}>
        <div className="grid grid-cols-1 gap-2">
          {SKIP_REASONS.map(([r, en]) => (
            <Button key={r} variant="secondary" onClick={async () => { setSkipOpen(false); await skipLead(r); }}>
              {t(r, en)}
            </Button>
          ))}
        </div>
      </Modal>
    </div>
  );
}

/** Slim call controls for the minimal screen: what is happening + hang up / dial / skip. Everything else lives in the lead card. */
function CallStrip({ canDialLead, onDialLead, onDialNext, canDialNext, blockedReason, onSkip, onContinueAuto }: { canDialLead: boolean; onDialLead: () => void; onDialNext: () => void; canDialNext: boolean; blockedReason: string | null; onSkip?: () => void; onContinueAuto?: () => void }) {
  const t = useT();
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
          <span>{t("חיוג אוטומטי בעוד", "Auto-dial in")} <b className="tabular text-warn">{countdown.secondsLeft}</b></span>
        ) : (
          <span className="text-muted">{blockedReason ?? t("אין שיחה פעילה", "No active call")}</span>
        )}
        {phone.status === "simulation" && <span className="text-muted text-xs">· {t("הדמיה", "Simulation")}</span>}
      </div>
      <div className="call-strip-actions">
        {inboundRinging ? (
          <><Button variant="good" onClick={acceptInbound} loading={busy === "accept"}>{t("קבל", "Accept")}</Button><Button variant="danger" onClick={rejectInbound} loading={busy === "reject"}>{t("דחה", "Reject")}</Button></>
        ) : inProgress ? (
          <><Button variant={phone.muted ? "warn" : "secondary"} onClick={phone.toggleMute} disabled={!answered || phone.status === "simulation"}>{phone.muted ? t("בטל השתקה", "Unmute") : t("השתק", "Mute")} <Kbd>M</Kbd></Button><Button variant="danger" onClick={hangup} loading={busy === "hangup"}>{t("נתק", "Hang up")} <Kbd>H</Kbd></Button></>
        ) : onContinueAuto ? (
          <Button variant="good" onClick={onContinueAuto} loading={busy === "outcome" || busy === "next" || busy === "dial"} data-testid="strip-continue">{t("המשך לליד הבא ›", "Next lead ›")}</Button>
        ) : (
          <>{onSkip && <Button variant="secondary" onClick={onSkip} disabled={!canDialLead}>{t("דלג", "Skip")} <Kbd>S</Kbd></Button>}<Button variant="good" onClick={canDialLead ? onDialLead : onDialNext} disabled={(!canDialLead && !canDialNext) || !connOk || busy === "dial" || busy === "next"} loading={busy === "dial" || busy === "next"} title={blockedReason ?? undefined} data-testid="strip-dial-lead">{t("חייג לליד", "Dial lead")} <Kbd>D</Kbd></Button></>
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
function NextBar({ call, canContinue, busy, onContinue, onFull }: { call: CallDto; canContinue: boolean; busy: boolean; onContinue: (p: WrapUpPick) => void; onFull: () => void }) {
  const t = useT();
  const { wrapUp: statuses } = useWrapUpStatuses(call.id);
  const answered = Boolean(call.answeredAt);
  // Technical result (from the provider) – apart from the business status the agent picks.
  const auto: OutcomeKey = call.telephonyResult === "busy" ? "busy" : "no_answer";
  const [pick, setPick] = useState<WrapUpPick | null>(answered ? null : { outcome: auto });
  return (
    <div className="next-bar" data-testid="next-bar">
      <div className="next-bar-info">
        <b>{t("השיחה הסתיימה", "Call ended")}</b>
        <span className="text-xs" data-testid="next-telephony">{t("טלפוניה:", "Telephony:")} <b>{answered ? t("נענתה", "Answered") : auto === "busy" ? t("תפוס", "Busy") : t("אין מענה", "No answer")}</b></span>
        {answered ? <span>{t("בחר סטטוס:", "Choose status:")}</span> : <span>{t("נרשם אוטומטית – אפשר גם לבחור סטטוס:", "Logged automatically – you can also choose a status:")}</span>}
        <div className="next-bar-chips">{statuses.map((s) => <button key={s.id} type="button" aria-pressed={pick?.statusId === s.id} onClick={() => setPick(pick?.statusId === s.id ? (answered ? null : { outcome: auto }) : { statusId: s.id, kind: s.kind })} data-testid={`next-status-${s.id}`} data-kind={s.kind}>{s.label}</button>)}</div>
        {pick?.kind === "follow_up" && <FollowUpFields value={pick} onChange={setPick} callId={call.id} />}
      </div>
      <PostCallWhatsApp callId={call.id} />
      <div className="next-bar-actions">
        <button type="button" className="next-bar-full" onClick={onFull} data-testid="next-full">{t("תיעוד מלא", "Full log")}</button>
        <Button variant="good" size="lg" disabled={!pickReady(pick) || busy} loading={busy} onClick={() => pick && onContinue(pick)} data-testid="next-continue">{canContinue ? t("המשך לליד הבא ›", "Next lead ›") : t("שמור", "Save")}</Button>
      </div>
    </div>
  );
}
