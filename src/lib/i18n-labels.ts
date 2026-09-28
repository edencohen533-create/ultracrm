/**
 * Shared label maps (statuses, outcomes, modules…) are read in many screens. Instead of changing every call site,
 * the maps themselves answer in the interface language: in the browser, English when <html lang="en">; on the
 * server always Hebrew – API responses, logs and audit texts do not change.
 */
import type { Lang } from "./i18n";

export function uiLang(): Lang {
  return typeof document !== "undefined" && document.documentElement.lang === "en" ? "en" : "he";
}

/** A Record whose string values switch to `en[key]` in an English UI (missing keys fall back to Hebrew). */
export function bi<T extends object>(he: T, en: { [K in keyof T]?: string }): T {
  return new Proxy(he, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v === "string" && typeof prop === "string" && uiLang() === "en") return (en as Record<string, string | undefined>)[prop] ?? v;
      return v;
    },
  });
}

/** Label for an object with a `label` field (e.g. outcome definitions). */
export function withLabel<T extends { label: string }>(item: T, en: string): T {
  const he = item.label;
  return Object.defineProperty({ ...item }, "label", { get: () => (uiLang() === "en" ? en : he), enumerable: true }) as T;
}
