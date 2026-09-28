/**
 * Interface language (he / en). The choice lives in the `lang` cookie so server and client render the same text
 * and direction. Strings are written inline as pairs – `t("שמור", "Save")` – so a screen is translated where it is
 * written, with no key catalog to keep in sync.
 */
export type Lang = "he" | "en";
export const LANG_COOKIE = "lang";
export const dirOf = (lang: Lang) => (lang === "en" ? "ltr" : "rtl");
export const pick = (lang: Lang, he: string, en: string) => (lang === "en" ? en : he);
export const parseLang = (v: string | undefined | null): Lang => (v === "en" ? "en" : "he");
