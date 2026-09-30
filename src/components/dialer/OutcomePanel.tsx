"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Kbd, cx } from "@/components/ui";
import { TELEPHONY_RESULT_LABEL, formatDuration } from "@/lib/client/format";
import type { CallDto, OutcomeKey } from "@/lib/client/types";
import { useHotkeys } from "./useHotkeys";
import { useT } from "@/components/i18n/LangProvider";
import { FollowUpFields, pickReady, useWrapUpStatuses, type WrapUpPick } from "./WrapUpStatus";

const KIND_TONE: Record<string, string> = {
  converted: "border-good/40 hover:bg-good/15 data-[sel=true]:bg-good data-[sel=true]:text-white",
  qualified: "border-good/40 hover:bg-good/15 data-[sel=true]:bg-good data-[sel=true]:text-white",
  unqualified: "border-line hover:bg-white/10 data-[sel=true]:bg-warn data-[sel=true]:text-black",
  lost: "border-line hover:bg-white/10 data-[sel=true]:bg-warn data-[sel=true]:text-black",
};
const DEFAULT_TONE = "border-line hover:bg-white/10 data-[sel=true]:bg-accent data-[sel=true]:text-white";
/** Technical telephony results – not CRM statuses. */
const TECHNICAL: Array<{ key: OutcomeKey; he: string; en: string }> = [
  { key: "no_answer", he: "אין מענה", en: "No answer" }, { key: "busy", he: "תפוס", en: "Busy" }, { key: "wrong_number", he: "מספר שגוי", en: "Wrong number" },
];

/**
 * Full wrap-up. Two separate choices:
 *  • the CRM status (the business's own statuses – renamed / added / deleted in the CRM show here at once); the
 *    status's MEANING decides what happens (follow-up asks for a date + time, sale opens the deal form…);
 *  • or a technical telephony result (no answer / busy / wrong number) and, apart, "do not contact" (blocks the number).
 */
export function OutcomePanel({ call, note, onSave, saving }: { call: CallDto; note: string; onSave: (p: WrapUpPick) => Promise<void>; saving: boolean }) {
  const t = useT();
  const { wrapUp: statuses } = useWrapUpStatuses(call.id);
  const answered = Boolean(call.answeredAt);
  const [pick, setPick] = useState<WrapUpPick | null>(null);

  // Sensible default from the provider's result – the agent can still change it.
  useEffect(() => { setPick(call.telephonyResult === "busy" ? { outcome: "busy" } : call.telephonyResult === "no_answer" ? { outcome: "no_answer" } : null); }, [call.id, call.telephonyResult]);

  const canSave = pickReady(pick) && !saving;
  const selStatus = (id: string, kind: string) => setPick({ statusId: id, kind });
  const hotkeys = useMemo(() => {
    const m: Record<string, () => void> = {};
    statuses.slice(0, 9).forEach((s, i) => { m[String(i + 1)] = () => selStatus(s.id, s.kind); });
    m.Enter = () => { if (canSave && pick) void onSave(pick); };
    return m;
  }, [statuses, canSave, pick, onSave]);
  useHotkeys(hotkeys);
  const chosen = statuses.find((s) => s.id === pick?.statusId);

  return (
    <div className="p-4 border-t border-line bg-panel-2/60" data-testid="outcome-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold">{t("סיום שיחה", "Call wrap-up")}</h3>
          <Badge tone={answered ? "good" : "neutral"}>{t("טלפוניה:", "Telephony:")} {call.telephonyResult ? TELEPHONY_RESULT_LABEL[call.telephonyResult] : "—"}</Badge>
          {answered && <span className="text-xs text-muted tabular">{t("משך", "Duration")} {formatDuration(call.talkSeconds)}</span>}
        </div>
        <span className="text-[11px] text-muted">{t(`מקשים 1–${Math.min(9, statuses.length)} לבחירת סטטוס · Enter לשמירה`, `Keys 1–${Math.min(9, statuses.length)} pick a status · Enter saves`)}</span>
      </div>

      <p className="mb-1 text-xs font-medium text-muted">{t("סטטוס בטיפול (CRM)", "Handling status (CRM)")}</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" data-testid="outcome-statuses">
        {statuses.map((s, i) => (
          <button key={s.id} type="button" data-sel={pick?.statusId === s.id} data-kind={s.kind} onClick={() => selStatus(s.id, s.kind)} className={cx("h-11 rounded-lg border text-sm font-medium transition-colors flex items-center justify-between px-3", KIND_TONE[s.kind] ?? DEFAULT_TONE)} data-testid={`outcome-status-${s.id}`}>
            <span className="truncate">{s.label}</span>{i < 9 && <Kbd>{i + 1}</Kbd>}
          </button>
        ))}
      </div>
      {pick?.kind === "follow_up" && <FollowUpFields value={pick} onChange={setPick} callId={call.id} />}
      {chosen?.kind === "converted" && <p className="mt-2 text-xs text-muted">{t("אחרי השמירה ייפתח טופס העסקה.", "The deal form opens after saving.")}</p>}

      <p className="mb-1 mt-3 text-xs font-medium text-muted">{t("או תוצאת טלפוניה (בלי שינוי סטטוס)", "Or a telephony result (no status change)")}</p>
      <div className="flex flex-wrap gap-2" data-testid="outcome-technical">
        {TECHNICAL.map((o) => <button key={o.key} type="button" data-sel={pick?.outcome === o.key} onClick={() => setPick({ outcome: o.key })} className={cx("h-9 rounded-lg border px-3 text-sm", DEFAULT_TONE)} data-testid={`outcome-tech-${o.key}`}>{t(o.he, o.en)}</button>)}
        <button type="button" data-sel={pick?.outcome === "dnc"} onClick={() => setPick({ outcome: "dnc" })} className="h-9 rounded-lg border border-bad/40 px-3 text-sm hover:bg-bad/15 data-[sel=true]:bg-bad data-[sel=true]:text-white" data-testid="outcome-tech-dnc">{t("לא ליצור קשר", "Do not contact")}</button>
      </div>
      {pick?.outcome === "dnc" && <p className="mt-2 text-xs text-bad">{t("המספר ייחסם לכל הרשימות של העסק ולא יחויג שוב.", "The number will be blocked across all of the business's lists and won't be dialed again.")}</p>}
      {!note.trim() && (chosen?.kind === "qualified" || chosen?.kind === "converted") && <p className="mt-2 text-xs text-warn">{t("מומלץ להוסיף הערה לפני השמירה.", "Adding a note before saving is recommended.")}</p>}
      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-muted">{t("ההערות מהכרטיס יישמרו יחד עם התוצאה", "Notes from the card will be saved with the outcome")}</span>
        <Button size="lg" disabled={!canSave} loading={saving} onClick={() => pick && void onSave(pick)} data-testid="outcome-save">{t("שמור והמשך", "Save and continue")}</Button>
      </div>
    </div>
  );
}
