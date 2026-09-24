"use client";

import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger" | "good" | "warn";
type Size = "sm" | "md" | "lg";

const variantCls: Record<Variant, string> = {
  primary: "bg-accent hover:bg-accent-2 text-white",
  secondary: "bg-white/8 hover:bg-white/12 text-text border border-line",
  ghost: "bg-transparent hover:bg-white/8 text-muted hover:text-text",
  danger: "bg-bad hover:bg-red-600 text-white",
  good: "bg-good hover:bg-green-600 text-white",
  warn: "bg-warn hover:bg-amber-600 text-black",
};
const sizeCls: Record<Size, string> = {
  sm: "h-8 px-3 text-xs rounded-md",
  md: "h-10 px-4 text-sm rounded-lg",
  lg: "h-12 px-6 text-base rounded-xl font-semibold",
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean; icon?: ReactNode }>(
  function Button({ variant = "primary", size = "md", loading, icon, className, children, disabled, ...rest }, ref) {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cx("inline-flex items-center justify-center gap-2 font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed select-none whitespace-nowrap", variantCls[variant], sizeCls[size], className)}
        {...rest}
      >
        {loading ? <Spinner className="w-4 h-4" /> : icon}
        {children}
      </button>
    );
  },
);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: string; ltr?: boolean }>(function Input({ label, hint, ltr, className, ...rest }, ref) {
  return (
    <label className="block">
      {label && <span className="block text-xs text-muted mb-1">{label}</span>}
      <input
        ref={ref}
        className={cx("w-full h-10 px-3 rounded-lg bg-bg border border-line text-text placeholder:text-muted/60 focus:border-accent transition-colors", ltr && "ltr text-left", className)}
        {...rest}
      />
      {hint && <span className="block text-[11px] text-muted mt-1">{hint}</span>}
    </label>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string }>(function Textarea({ label, className, ...rest }, ref) {
  return (
    <label className="block">
      {label && <span className="block text-xs text-muted mb-1">{label}</span>}
      <textarea ref={ref} className={cx("w-full px-3 py-2 rounded-lg bg-bg border border-line text-text placeholder:text-muted/60 focus:border-accent transition-colors resize-y", className)} {...rest} />
    </label>
  );
});

export function Select({ label, className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label?: string }) {
  return (
    <label className="block">
      {label && <span className="block text-xs text-muted mb-1">{label}</span>}
      <select className={cx("w-full h-10 px-3 rounded-lg bg-bg border border-line text-text focus:border-accent transition-colors", className)} {...rest}>
        {children}
      </select>
    </label>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx("animate-spin", className ?? "w-5 h-5")} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

type Tone = "neutral" | "good" | "warn" | "bad" | "info" | "accent";
const toneCls: Record<Tone, string> = {
  neutral: "bg-white/8 text-muted",
  good: "bg-good/15 text-good",
  warn: "bg-warn/15 text-warn",
  bad: "bg-bad/15 text-bad",
  info: "bg-info/15 text-info",
  accent: "bg-accent/20 text-[#aab3ff]",
};

export function Badge({ tone = "neutral", children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 px-2 h-6 rounded-md text-xs font-medium whitespace-nowrap", toneCls[tone], className)}>
      {dot && <span className="w-1.5 h-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function Panel({ title, actions, children, className, bodyClassName }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cx("bg-panel border border-line rounded-xl flex flex-col min-h-0", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 px-4 h-11 border-b border-line shrink-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={cx("p-4 min-h-0", bodyClassName)}>{children}</div>
    </section>
  );
}

export function Phone({ value, className }: { value: string | null | undefined; className?: string }) {
  if (!value) return <span className={className}>—</span>;
  return (
    <span dir="ltr" className={cx("phone", className)}>
      {value}
    </span>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-10 px-4 text-muted">
      <p className="text-sm font-medium text-text">{title}</p>
      {hint && <p className="text-xs mt-1 max-w-sm">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-8 px-4">
      <p className="text-sm text-bad">{message}</p>
      {retry && (
        <Button variant="secondary" size="sm" className="mt-3" onClick={retry}>
          נסה שוב
        </Button>
      )}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, width = "max-w-lg" }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: string }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal className={cx("w-full bg-panel border border-line rounded-2xl shadow-2xl flex flex-col max-h-[90vh]", width)}>
        <header className="flex items-center justify-between px-5 h-12 border-b border-line">
          <h3 className="font-semibold">{title}</h3>
          <button onClick={onClose} className="text-muted hover:text-text text-xl leading-none px-1" aria-label="סגור">
            ×
          </button>
        </header>
        <div className="p-5 overflow-y-auto">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 px-5 h-14 border-t border-line">{footer}</footer>}
      </div>
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className="bg-panel-2 border border-line rounded-lg px-3 py-2 min-w-0">
      <p className="text-[11px] text-muted truncate">{label}</p>
      <p className={cx("text-xl font-semibold tabular leading-tight", tone === "good" && "text-good", tone === "bad" && "text-bad", tone === "warn" && "text-warn")}>{value}</p>
      {sub && <p className="text-[11px] text-muted truncate">{sub}</p>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex items-center justify-center min-w-5 h-5 px-1 rounded bg-black/40 border border-line text-[10px] text-muted font-mono">{children}</kbd>;
}
