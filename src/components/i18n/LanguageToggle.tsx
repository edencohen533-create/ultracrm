"use client";

import { Languages } from "lucide-react";
import { setLang, useT } from "./LangProvider";
import { cx } from "@/components/ui";

/** "English" ⇄ "עברית" – switches the whole interface (text + direction) and remembers it. */
export function LanguageToggle({ className }: { className?: string }) {
  const t = useT();
  return (
    <button type="button" onClick={() => setLang(t.lang === "en" ? "he" : "en")} className={cx("inline-flex items-center gap-1.5 text-xs font-medium hover:underline", className)} data-testid="lang-toggle" aria-label={t.lang === "en" ? "החלפה לעברית" : "Switch to English"}>
      <Languages size={14} />{t.lang === "en" ? "עברית" : "English"}
    </button>
  );
}
