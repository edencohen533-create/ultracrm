"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useT } from "@/components/i18n/LangProvider";

/**
 * "?" next to a section: opens a short explanation on click / tap / Enter / Space (not hover only), closes on
 * Escape, a second click or a click outside. The text is linked to the button for screen readers.
 */
export function HelpTip({ label, children, testId, hover = false }: { label: string; children: React.ReactNode; testId?: string; hover?: boolean }) {
  const t = useT();
  const [pinned, setPinned] = useState(false);
  // `hover`: also shown while the pointer is over the button or it has keyboard focus (click still pins it open).
  const [peek, setPeek] = useState(false);
  const open = pinned || peek;
  const toggle = () => { if (pinned) { setPinned(false); setPeek(false); } else setPinned(true); };
  const id = useId();
  const box = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  // Placed under the button and kept inside the screen (narrow phones, RTL, buttons near an edge).
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const place = () => {
      const r = btn.current!.getBoundingClientRect();
      const width = Math.min(320, window.innerWidth - 16);
      const left = Math.max(8, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8));
      setPos({ top: r.bottom + 6, left, width });
    };
    place();
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setPinned(false); setPeek(false); } };
    const onDown = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) { setPinned(false); setPeek(false); } };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pointerdown", onDown); };
  }, [open]);
  return (
    <span ref={box} className="relative inline-flex align-middle" onMouseEnter={hover ? () => setPeek(true) : undefined} onMouseLeave={hover ? () => setPeek(false) : undefined}>
      <button ref={btn} type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggle(); }} aria-expanded={open} aria-controls={id}
        onFocus={hover ? () => setPeek(true) : undefined} onBlur={hover ? () => setPeek(false) : undefined}
        aria-label={t(`הסבר: ${label}`, `Help: ${label}`)} data-testid={testId}
        className="relative ms-1 inline-flex h-5 w-5 items-center before:absolute before:-inset-3 before:content-[''] justify-center rounded-full border border-line text-[11px] font-semibold text-muted hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">?</button>
      {open && (
        <span id={id} role="note" className="fixed z-50 rounded-lg border border-line bg-panel p-3 text-start text-xs font-normal leading-relaxed text-text shadow-lg" style={pos ? { top: pos.top, left: pos.left, width: pos.width } : { visibility: "hidden" }} data-testid={testId ? `${testId}-text` : undefined}>
          {children}
        </span>
      )}
    </span>
  );
}
