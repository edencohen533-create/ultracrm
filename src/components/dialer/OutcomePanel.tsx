"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Input, Kbd, cx } from "@/components/ui";
import { OUTCOMES } from "@/lib/outcomes";
import { TELEPHONY_RESULT_LABEL, formatDuration, toLocalInputValue } from "@/lib/client/format";
import type { CallDto, OutcomeKey } from "@/lib/client/types";
import { useHotkeys } from "./useHotkeys";

const toneCls: Record<string, string> = {
  good: "border-good/40 hover:bg-good/15 data-[sel=true]:bg-good data-[sel=true]:text-white",
  neutral: "border-line hover:bg-white/10 data-[sel=true]:bg-accent data-[sel=true]:text-white",
  bad: "border-line hover:bg-white/10 data-[sel=true]:bg-warn data-[sel=true]:text-black",
  danger: "border-bad/40 hover:bg-bad/15 data-[sel=true]:bg-bad data-[sel=true]:text-white",
};

export function OutcomePanel({ call, note, onSave, saving }: { call: CallDto; note: string; onSave: (outcome: OutcomeKey, callbackAt?: Date) => Promise<void>; saving: boolean }) {
  const [selected, setSelected] = useState<OutcomeKey | null>(null);
  const [callbackAt, setCallbackAt] = useState("");
  const answered = Boolean(call.answeredAt);
  const [minLocal] = useState(() => toLocalInputValue(new Date()));

  // Sensible default from the provider's result – the agent can still change it.
  useEffect(() => {
    setSelected(call.telephonyResult === "busy" ? "busy" : call.telephonyResult === "no_answer" ? "no_answer" : null);
    setCallbackAt("");
  }, [call.id, call.telephonyResult]);

  const def = useMemo(() => OUTCOMES.find((o) => o.key === selected) ?? null, [selected]);
  const canSave = Boolean(def) && (!def?.requiresCallbackTime || Boolean(callbackAt)) && !saving;

  const hotkeys = useMemo(() => {
    const m: Record<string, () => void> = {};
    for (const o of OUTCOMES) m[o.hotkey] = () => setSelected(o.key);
    m.Enter = () => { if (canSave && def) onSave(def.key, callbackAt ? new Date(callbackAt) : undefined); };
    return m;
  }, [canSave, def, onSave, callbackAt]);
  useHotkeys(hotkeys);

  const quickCallback = (hours: number) => {
    const d = new Date();
    d.setHours(d.getHours() + hours);
    d.setSeconds(0, 0);
    setCallbackAt(toLocalInputValue(d));
  };

  return (
    <div className="p-4 border-t border-line bg-panel-2/60">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold">תוצאת שיחה</h3>
          <Badge tone={answered ? "good" : "neutral"}>ספק: {call.telephonyResult ? TELEPHONY_RESULT_LABEL[call.telephonyResult] : "—"}</Badge>
          {answered && <span className="text-xs text-muted tabular">משך {formatDuration(call.talkSeconds)}</span>}
        </div>
        <span className="text-[11px] text-muted">מקשים 1–8 לבחירה · Enter לשמירה</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {OUTCOMES.map((o) => (
          <button
            key={o.key}
            data-sel={selected === o.key}
            onClick={() => setSelected(o.key)}
            className={cx("h-11 rounded-lg border text-sm font-medium transition-colors flex items-center justify-between px-3", toneCls[o.tone])}
          >
            <span>{o.label}</span>
            <Kbd>{o.hotkey}</Kbd>
          </button>
        ))}
      </div>
      {def?.requiresCallbackTime && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Input label="מועד חזרה" type="datetime-local" value={callbackAt} onChange={(e) => setCallbackAt(e.target.value)} min={minLocal} className="h-9" ltr />
          {[1, 3, 24, 72].map((h) => (
            <Button key={h} size="sm" variant="secondary" onClick={() => quickCallback(h)}>
              {h < 24 ? `בעוד ${h} שע׳` : `בעוד ${h / 24} ימים`}
            </Button>
          ))}
        </div>
      )}
      {def?.addsToDnc && <p className="mt-2 text-xs text-bad">המספר ייחסם לכל הרשימות של העסק ולא יחויג שוב.</p>}
      {!note.trim() && def && (def.key === "answered_interested" || def.key === "sale") && <p className="mt-2 text-xs text-warn">מומלץ להוסיף הערה לפני השמירה.</p>}
      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-muted">ההערות מהכרטיס יישמרו יחד עם התוצאה</span>
        <Button size="lg" disabled={!canSave} loading={saving} onClick={() => def && onSave(def.key, callbackAt ? new Date(callbackAt) : undefined)}>
          שמור תוצאה והמשך
        </Button>
      </div>
    </div>
  );
}
