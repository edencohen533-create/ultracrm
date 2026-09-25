/**
 * Meta Graph API helpers shared by Embedded Signup, the WhatsApp provider and the
 * webhook route. All secrets live server-side (env or sealed DB config).
 */
import { openSecret, sealSecret } from "@/lib/crypto";
import type { MetaWhatsAppConfig } from "@/server/providers/meta-whatsapp-provider";

export const GRAPH_VERSION = process.env.META_GRAPH_VERSION?.trim() || "v25.0";
export const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

export interface MetaAppEnv {
  appId: string | null;
  appSecret: string | null;
  configId: string | null;
  webhookVerifyToken: string | null;
  encryption: boolean;
}

export function metaAppEnv(): MetaAppEnv {
  return {
    appId: process.env.META_APP_ID?.trim() || null,
    appSecret: process.env.META_APP_SECRET?.trim() || null,
    configId: process.env.META_ES_CONFIG_ID?.trim() || null,
    webhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN?.trim() || null,
    encryption: Boolean(process.env.ENCRYPTION_KEY?.trim()),
  };
}

/** What is still missing for Embedded Signup to be offered at all. */
export function embeddedSignupReadiness() {
  const env = metaAppEnv();
  const missing: string[] = [];
  if (!env.appId) missing.push("META_APP_ID");
  if (!env.appSecret) missing.push("META_APP_SECRET");
  if (!env.configId) missing.push("META_ES_CONFIG_ID");
  if (!env.webhookVerifyToken) missing.push("META_WEBHOOK_VERIFY_TOKEN");
  if (!env.encryption) missing.push("ENCRYPTION_KEY");
  return { ready: missing.length === 0, missing, appId: env.appId, configId: env.configId, version: GRAPH_VERSION };
}

export class GraphError extends Error {
  constructor(message: string, readonly code: number | null, readonly subcode: number | null, readonly status: number) {
    super(message);
    this.name = "GraphError";
  }
}

/** Typed Graph call. Never logs tokens; error text comes from Meta's error object only. */
export async function graph<T = Record<string, unknown>>(path: string, init: { method?: "GET" | "POST" | "DELETE"; token?: string; body?: unknown; query?: Record<string, string | undefined>; timeoutMs?: number } = {}): Promise<T> {
  const url = new URL(`${GRAPH_BASE}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: { ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}), ...(init.body ? { "Content-Type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
    redirect: "error",
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number; error_subcode?: number; type?: string } } & T;
  if (!res.ok || data.error) {
    const e = data.error ?? {};
    throw new GraphError(e.message ?? `Meta API error (${res.status})`, e.code ?? null, e.error_subcode ?? null, res.status);
  }
  return data;
}

/** App access token for /debug_token (never sent to the browser). */
export function appAccessToken() {
  const env = metaAppEnv();
  if (!env.appId || !env.appSecret) throw new Error("META_APP_ID / META_APP_SECRET are not configured");
  return `${env.appId}|${env.appSecret}`;
}

/** Decrypt a stored credential config for use by the provider. */
export function metaConfigOf(config: unknown): MetaWhatsAppConfig {
  const c = (config ?? {}) as Record<string, string | undefined>;
  return {
    accessToken: openSecret(c.accessToken) ?? "",
    phoneNumberId: c.phoneNumberId ?? "",
    businessAccountId: c.businessAccountId,
    webhookVerifyToken: openSecret(c.webhookVerifyToken) ?? "",
    appSecret: openSecret(c.appSecret),
    apiVersion: c.apiVersion,
    twoStepPin: openSecret(c.twoStepPin),
  };
}

/** Seal the secret fields of a config before writing it to the database. */
export function sealMetaConfig(config: Partial<MetaWhatsAppConfig> & Record<string, unknown>) {
  const out: Record<string, unknown> = { ...config };
  for (const k of ["accessToken", "appSecret", "webhookVerifyToken", "twoStepPin"] as const) {
    const v = config[k];
    if (typeof v === "string" && v && !v.startsWith("enc:v1:")) out[k] = sealSecret(v);
  }
  return out;
}
