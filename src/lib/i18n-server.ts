import { cookies, headers } from "next/headers";
import { LANG_COOKIE, parseLang, pick, type Lang } from "./i18n";

/** Language of the current request (server components / route handlers). */
export async function getLang(): Promise<Lang> {
  const cookie = (await cookies()).get(LANG_COOKIE)?.value;
  // No cookie on a public page: src/proxy.ts picked the language from the browser.
  return parseLang(cookie ?? (await headers()).get("x-public-lang"));
}
/** Server-side translator: `const t = await serverT(); t("שלום", "Hello")`. */
export async function serverT() { const lang = await getLang(); return Object.assign((he: string, en: string) => pick(lang, he, en), { lang }); }
