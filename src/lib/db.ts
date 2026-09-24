import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { currentBusinessId } from "@/lib/tenant";

export function dbSchema(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? "").searchParams.get("schema") ?? "public";
  } catch {
    return "public";
  }
}

function createClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const url = new URL(connectionString);
  const schema = url.searchParams.get("schema") ?? "public";
  url.searchParams.delete("schema");
  const adapter = new PrismaPg({ connectionString: url.toString(), max: Number(process.env.DATABASE_POOL_MAX ?? 10) }, { schema });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    transactionOptions: { maxWait: 10_000, timeout: 20_000 },
  });
}

/**
 * Models that carry `businessId`. Queries on them are scoped to the current
 * business context automatically (see `prisma` below).
 */
const TENANT_MODELS = new Set<string>([
  "User", "Team", "UsageCounter", "Contact", "ContactPhone", "ContactEmail", "Tag", "Lead", "Deal", "Task", "Note",
  "Suppression", "DncEntry", "DomainEvent", "AutomationJob", "AuditLog",
  "DialList", "ListLead", "DialerSession", "Call", "CallMonitor", "PhoneNumber", "Script", "NoteDraft",
  "ProviderCredential", "Conversation", "Message", "ConversationDraft", "CannedReply", "Template",
  "AutomationRule", "AutomationRun", "DistributionList", "Campaign", "WhatsAppSignupSession",
  "MarketingSequence", "SequenceRun",
]);

/**
 * Models that must NEVER be queried without a business context (they belong to
 * the CRM / messaging modules whose code relies on the automatic scoping).
 * Telephony / identity models are exempt because login, webhook routing and
 * inbound-call routing legitimately run before a tenant is known.
 */
const STRICT_MODELS = new Set<string>([
  "Lead", "Deal", "Note", "Suppression", "Tag", "ProviderCredential", "Conversation", "Message", "ConversationDraft",
  "CannedReply", "Template", "AutomationRule", "AutomationRun", "DistributionList", "Campaign", "WhatsAppSignupSession",
  "MarketingSequence", "SequenceRun",
]);

const WHERE_FILTER_OPS = new Set(["findMany", "findFirst", "findFirstOrThrow", "count", "aggregate", "groupBy", "updateMany", "updateManyAndReturn", "deleteMany"]);
const WHERE_UNIQUE_OPS = new Set(["findUnique", "findUniqueOrThrow", "update", "delete"]);

type AnyArgs = Record<string, unknown> & { where?: Record<string, unknown>; data?: unknown; create?: Record<string, unknown> };

function withBusinessData(data: unknown, businessId: string): unknown {
  if (Array.isArray(data)) return data.map((d) => withBusinessData(d, businessId));
  if (!data || typeof data !== "object") return data;
  const d = data as Record<string, unknown>;
  if ("businessId" in d || "business" in d) return d;
  return { ...d, businessId };
}

function scopeArgs(operation: string, rawArgs: unknown, businessId: string): unknown {
  const args: AnyArgs = { ...((rawArgs as AnyArgs) ?? {}) };
  if (WHERE_FILTER_OPS.has(operation)) {
    args.where = args.where ? { AND: [args.where, { businessId }] } : { businessId };
  } else if (WHERE_UNIQUE_OPS.has(operation)) {
    args.where = { ...(args.where ?? {}), businessId };
  } else if (operation === "upsert") {
    args.where = { ...(args.where ?? {}), businessId };
    args.create = withBusinessData(args.create, businessId) as Record<string, unknown>;
  } else if (operation === "create" || operation === "createMany" || operation === "createManyAndReturn") {
    args.data = withBusinessData(args.data, businessId);
  }
  return args;
}

function createScopedClient(base: PrismaClient) {
  return base.$extends({
    name: "business-scope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!TENANT_MODELS.has(model)) return query(args);
          const businessId = currentBusinessId();
          if (!businessId) {
            if (STRICT_MODELS.has(model)) throw new Error(`Business context is required to access ${model}`);
            return query(args);
          }
          return query(scopeArgs(operation, args, businessId) as typeof args);
        },
      },
    },
  });
}

// The query extension does not change the client surface, so the scoped client is typed as a plain
// PrismaClient: `prisma.$transaction((tx) => …)` hands services a `Prisma.TransactionClient` as before.
const globalForPrisma = globalThis as unknown as { db?: PrismaClient; prisma?: PrismaClient };

/** Unscoped client. Only for trusted bootstrap paths: login, webhook routing, cron enumeration, migrations/seeds. */
export const db: PrismaClient = globalForPrisma.db ?? createClient();
/** Business-scoped client used by all application code. */
export const prisma: PrismaClient = globalForPrisma.prisma ?? (createScopedClient(db) as unknown as PrismaClient);

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.db = db;
  globalForPrisma.prisma = prisma;
}

export type { PrismaClient, Prisma };
/** Transaction client type accepted by services (works for both the scoped client and a `$transaction` client). */
export type Db = Prisma.TransactionClient;
