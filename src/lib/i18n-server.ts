import { cookies } from "next/headers";
import { LANG_COOKIE, parseLang, pick, type Lang } from "./i18n";

/** Language of the current request (server components / route handlers). */
export async function getLang(): Promise<Lang> { return parseLang((await cookies()).get(LANG_COOKIE)?.value); }
/** Server-side translator: `const t = await serverT(); t("שלום", "Hello")`. */
export async function serverT() { const lang = await getLang(); return Object.assign((he: string, en: string) => pick(lang, he, en), { lang }); }
