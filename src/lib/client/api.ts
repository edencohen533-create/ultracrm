"use client";
import { uiLang } from "@/lib/i18n-labels";

export class ApiClientError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(message: string, status: number, code: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Last API errors (code / path / status only – no bodies, no query strings) for "דווח על תקלה". */
export function recordClientError(e: { status?: number; code?: string; path?: string; message?: string }) {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __ucrmErrors?: unknown[] };
  w.__ucrmErrors = [...(w.__ucrmErrors ?? []), { at: new Date().toISOString(), ...e }].slice(-20);
}
export function recentClientErrors() { return typeof window === "undefined" ? [] : (((window as unknown as { __ucrmErrors?: unknown[] }).__ucrmErrors ?? []) as Array<{ at: string; status?: number; code?: string; path?: string; message?: string }>); }

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) }, cache: "no-store" });
  let json: { success?: boolean; data?: T; error?: string; code?: string; details?: unknown } = {};
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok || json.success === false) {
    if (res.status === 401 && typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
    }
    recordClientError({ status: res.status, code: json.code ?? "error", path: url.replace(/\?.*$/, ""), message: (json.error ?? "").slice(0, 200) });
    throw new ApiClientError(json.error ?? (uiLang() === "en" ? `Error (${res.status})` : `שגיאה (${res.status})`), res.status, json.code ?? "error", json.details);
  }
  return json.data as T;
}

export const api = {
  get: <T>(url: string) => request<T>(url),
  post: <T>(url: string, body?: unknown) => request<T>(url, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(url: string, body?: unknown) => request<T>(url, { method: "PUT", body: JSON.stringify(body ?? {}) }),
  patch: <T>(url: string, body?: unknown) => request<T>(url, { method: "PATCH", body: JSON.stringify(body ?? {}) }),
  delete: <T>(url: string, body?: unknown) => request<T>(url, { method: "DELETE", body: body === undefined ? undefined : JSON.stringify(body) }),
};

export function qs(params: Record<string, string | number | boolean | undefined | null>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}
