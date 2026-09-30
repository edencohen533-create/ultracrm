/**
 * External CRM connectors – the vendor-specific part. Shared infrastructure (queues, mapping, permissions, retries,
 * event log, identity links) lives next to this in src/server/crm-sync and never calls a vendor API directly.
 * A connector declares what it really supports; the UI and the sync engine offer only those capabilities.
 */
export const CAPABILITIES = {
  test: "בדיקת חיבור והרשאות",
  list_users: "שליפת משתמשים",
  list_fields: "שליפת שדות",
  list_statuses: "שליפת סטטוסים",
  list_lists: "שליפת רשימות",
  pull_contacts: "סנכרון אנשי קשר (משיכה)",
  pull_leads: "סנכרון פניות (משיכה)",
  push_api: "קבלת רשומות דרך API (דחיפה מהמערכת החיצונית)",
  webhooks: "קבלת עדכונים ב-Webhook",
  write_call: "כתיבת פעילות שיחה",
  update_call: "עדכון פעילות (סיכום AI מאוחר)",
  upsert_task: "יצירה ועדכון משימת פולואפ",
  update_status: "עדכון סטטוס",
  request_block: "בקשת חסימה",
  find_by_correlation: "איתור פעולה קודמת לפי מזהה מתאם (מניעת כפילות בניסיון חוזר)",
} as const;
export type Capability = keyof typeof CAPABILITIES;

export interface ExtContact {
  externalId: string; name?: string | null; phones?: string[]; email?: string | null; ownerExternalId?: string | null;
  source?: string | null; campaign?: string | null; product?: string | null; tags?: string[]; customFields?: Record<string, string | number | boolean | null>;
  isCustomer?: boolean; purchases?: Array<{ externalId: string; amount: number; currency?: string; at: string }>;
  updatedAt?: string | null; version?: string | null; deleted?: boolean;
}
export interface ExtLead {
  externalId: string; contactExternalId: string; title?: string | null; status?: string | null; ownerExternalId?: string | null;
  followUpAt?: string | null; timezone?: string | null; product?: string | null; source?: string | null; campaign?: string | null; list?: string | null;
  team?: string | null; tags?: string[]; customFields?: Record<string, string | number | boolean | null>; updatedAt?: string | null; version?: string | null; deleted?: boolean;
}
export type InboundChange = { eventId: string; occurredAt?: string | null } & ({ recordType: "contact"; record: ExtContact } | { recordType: "lead"; record: ExtLead });
export interface ExtUser { externalId: string; name: string; email?: string | null }
export interface Page<T> { items: T[]; nextCursor: string | null; retryAfterSec?: number | null }

export interface ConnectorCtx { connectionId: string; businessId: string; auth: Record<string, string>; settings: import("./settings").CrmSettings }
/** Write-back of one of our activities. `correlationId` is stable across retries – the vendor gets it as an idempotency marker. */
export interface OutboundCall { correlationId: string; contactExternalId: string | null; leadExternalId: string | null; at: string; direction: "inbound" | "outbound"; durationSec: number | null; result: string; outcome: string | null; agent: string | null; note: string | null; aiSummary: string | null; detailsUrl: string | null }
export interface OutboundTask { correlationId: string; contactExternalId: string | null; leadExternalId: string | null; dueAt: string; timezone: string; title: string; note: string | null; assigneeExternalId: string | null; done: boolean }

export class ConnectorError extends Error {
  /** transient = retry; ambiguous = the vendor may have done it (look up before retrying); rate_limit; auth; invalid */
  constructor(message: string, readonly kind: "transient" | "ambiguous" | "rate_limit" | "auth" | "invalid", readonly retryAfterSec: number | null = null) { super(message); this.name = "ConnectorError"; }
}

export interface ConnectorDef {
  key: string; name: string; description: string;
  /** tested = built and covered by tests; needs_setup = works but needs configuration outside UltraCRM; unavailable */
  availability: "tested" | "needs_setup" | "unavailable";
  /** Hidden from the business UI (e.g. the test simulator). */
  internal?: boolean;
  authFields: Array<{ key: string; label: string; secret: boolean; required: boolean; placeholder?: string; help?: string }>;
  capabilities: Capability[];
  test(ctx: ConnectorCtx): Promise<{ ok: boolean; message: string; permissions?: string[]; details?: Record<string, unknown> }>;
  listUsers?(ctx: ConnectorCtx): Promise<ExtUser[]>;
  listStatuses?(ctx: ConnectorCtx): Promise<string[]>;
  listFields?(ctx: ConnectorCtx): Promise<Array<{ key: string; label: string }>>;
  listLists?(ctx: ConnectorCtx): Promise<string[]>;
  pull?(ctx: ConnectorCtx, recordType: "contact" | "lead", cursor: string | null, since: string | null): Promise<Page<InboundChange>>;
  verifyWebhook?(ctx: ConnectorCtx, headers: Headers, rawBody: string): boolean;
  parseWebhook?(ctx: ConnectorCtx, body: unknown): InboundChange[];
  writeCall?(ctx: ConnectorCtx, call: OutboundCall): Promise<{ externalId: string }>;
  updateCall?(ctx: ConnectorCtx, externalId: string, patch: Partial<OutboundCall>): Promise<void>;
  upsertTask?(ctx: ConnectorCtx, task: OutboundTask, externalId: string | null): Promise<{ externalId: string }>;
  updateStatus?(ctx: ConnectorCtx, leadExternalId: string, status: string, correlationId: string): Promise<void>;
  requestBlock?(ctx: ConnectorCtx, contactExternalId: string, reason: string, correlationId: string): Promise<void>;
  findByCorrelation?(ctx: ConnectorCtx, kind: "call" | "task", correlationId: string): Promise<string | null>;
}
