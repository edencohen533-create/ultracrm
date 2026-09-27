ALTER TABLE "accounts" ADD COLUMN     "is_platform_admin" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "businesses" ADD COLUMN     "access_status" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "access_until" TIMESTAMP(3),
ADD COLUMN     "billing_status" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN     "plan_version_id" TEXT;

ALTER TABLE "plans" ADD COLUMN     "current_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "is_archived" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "users" ADD COLUMN     "permissions" JSONB;

-- CreateTable
CREATE TABLE "plan_versions" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "modules" JSONB NOT NULL DEFAULT '{}',
    "quotas" JSONB NOT NULL DEFAULT '{}',
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entitlement_grants" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "seats" INTEGER,
    "starts_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "note" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entitlement_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_audit_logs" (
    "id" TEXT NOT NULL,
    "business_id" TEXT,
    "actor_account_id" TEXT,
    "target_user_id" TEXT,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plan_versions_plan_id_version_key" ON "plan_versions"("plan_id", "version");

-- CreateIndex
CREATE INDEX "entitlement_grants_business_id_module_idx" ON "entitlement_grants"("business_id", "module");

-- CreateIndex
CREATE INDEX "access_audit_logs_business_id_created_at_idx" ON "access_audit_logs"("business_id", "created_at");

-- AddForeignKey
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_plan_version_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "plan_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Data migration (safe, no access widened) ──────────────────────────────────────────────────────────────────
-- 1. "messaging" was one module for WhatsApp + SMS + email → the three modules (same value), in plans and overrides.
UPDATE "plans" SET "modules" = ("modules" - 'messaging') || jsonb_build_object('whatsapp', "modules"->'messaging', 'sms', "modules"->'messaging', 'email', "modules"->'messaging')
  WHERE "modules" ? 'messaging';
UPDATE "businesses" SET "modules" = ("modules" - 'messaging') || jsonb_build_object('whatsapp', "modules"->'messaging', 'sms', "modules"->'messaging', 'email', "modules"->'messaging')
  WHERE "modules" ? 'messaging';
-- 2. Every existing plan becomes version 1 of itself; businesses are pinned to it (nothing changes for them).
INSERT INTO "plan_versions" ("id", "plan_id", "version", "name", "modules", "quotas", "created_at")
  SELECT 'pv_' || p."id", p."id", 1, p."name",
    (SELECT COALESCE(jsonb_object_agg(k.key, jsonb_build_object('included', k.value = 'true'::jsonb, 'seats', NULL)), '{}'::jsonb) FROM jsonb_each(p."modules") k),
    p."quotas", now()
  FROM "plans" p ON CONFLICT DO NOTHING;
UPDATE "businesses" b SET "plan_version_id" = 'pv_' || b."plan_id" WHERE b."plan_id" IS NOT NULL AND b."plan_version_id" IS NULL;

-- ─── RLS for the new business tables ───────────────────────────────────────────────────────────────────────────
ALTER TABLE "entitlement_grants" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "entitlement_grants" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
ALTER TABLE "access_audit_logs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "access_audit_logs" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
