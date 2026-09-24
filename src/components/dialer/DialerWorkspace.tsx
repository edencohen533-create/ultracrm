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
import { useHotkeys } from "./useHotkeys";
import type { OutcomeKey } from "@/lib/client/types";

const SKIP_REASONS = ["לא זמן מתאים", "פרטים חסרים", "כבר דיברתי איתו", "ליד לא רלוונטי", "אחר"];

export function DialerWorkspace() {
  const d = useDialer();
  const { state, loading, error, refresh, dial, hangup, skipLead, saveOutcome, busy, sessionTakenOver, countdown, cancelCountdown, sessionSummary, dismissSummary } = d;
  const [note, setNote] = useState("");
  const [skipOpen, setSkipOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

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

  const dialManual = useCallback(
    async (phone: string) => {
      if (call) return toast.error("יש שיחה פעילה");
      if (wrapUp) return toast.error("תעד את השיחה הקודמת קודם");
      await dial({ mode: "manual", phone });
    },
    [call, wrapUp, dial],
  );

  const onSave = useCallback(
    async (outcome: OutcomeKey, callbackAt?: Date) => {
      if (!wrapUp) return;
      try {
        await saveOutcome(wrapUp.id, outcome, { note, callbackAt });
        setNote("");
        if (wrapUp.contactId) {
          try {
            localStorage.removeItem(`dialer.note.${wrapUp.contactId}`);
          } catch {
            /* ignore */
          }
        }
        toast.success("התוצאה נשמרה");
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
    <div className="flex flex-col h-screen min-h-0">
      <header className="px-4 py-3 border-b border-line bg-panel/60 shrink-0">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-base font-semibold">מסך עבודה</h1>
          {state?.telephony.simulation && <Badge tone="warn">מצב הדמיה – השיחות אינן אמיתיות</Badge>}
          {error && <Badge tone="bad">אין חיבור לשרת – מנסה שוב</Badge>}
        </div>
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

      <div className="flex-1 min-h-0 grid grid-cols-[300px_minmax(0,1fr)_320px]">
        {/* Queue (right in RTL) */}
        <aside className="border-s-0 border-e border-line bg-panel min-h-0">
          {session?.listId ? (
            <LeadQueue listId={session.listId} currentLeadId={lead?.id} refreshKey={refreshKey} />
          ) : (
            <div className="p-4 text-xs text-muted">בחר רשימה והתחל סשן כדי לראות את התור.</div>
          )}
        </aside>

        {/* Active lead */}
        <section className="min-h-0 flex flex-col">
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
          {wrapUp && !call && <OutcomePanel call={wrapUp} note={note} onSave={onSave} saving={busy === "outcome"} />}
        </section>

        {/* Call panel (left in RTL) */}
        <aside className="border-s border-line bg-panel min-h-0">
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
