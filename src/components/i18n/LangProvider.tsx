"use client";

import { createContext, useCallback, useContext } from "react";
import { LANG_COOKIE, dirOf, pick, type Lang } from "@/lib/i18n";

const Ctx = createContext<Lang>("he");

export function LangProvider({ lang, children }: { lang: Lang; children: React.ReactNode }) {
  return <Ctx.Provider value={lang}>{children}</Ctx.Provider>;
}

/** `const t = useT(); t("שמור", "Save")` – plus `t.lang` / `t.dir`. */
export function useT() {
  const lang = useContext(Ctx);
  const t = useCallback((he: string, en: string) => pick(lang, he, en), [lang]);
  return Object.assign(t, { lang, dir: dirOf(lang) });
}

export function setLang(lang: Lang) {
  document.cookie = `${LANG_COOKIE}=${lang}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  window.location.reload();
}
