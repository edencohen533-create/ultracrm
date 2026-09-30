-- Marketing & sales report: Meta Ads accounts / structure / daily ad-level delivery, sync runs, and lead touchpoints.
-- Additive only. The existing single-account connection (manual token) is carried over as a connected account.

-- AlterTable
ALTER TABLE "meta_ad_connections" ADD COLUMN     "connected_by_id" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'manual_token',
ADD COLUMN     "last_checked_at" TIMESTAMP(3),
ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "meta_user_id" TEXT,
ADD COLUMN     "meta_user_name" TEXT,
ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "token_expires_at" TIMESTAMP(3),
ALTER COLUMN "account_id" DROP NOT NULL,
ALTER COLUMN "account_name" DROP NOT NULL;

-- CreateTable
CREATE TABLE "meta_ad_accounts" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "connection_id" TEXT,
    "account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT,
    "timezone_name" TEXT,
    "account_status" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'active',
    "sync_from" DATE,
    "synced_through" DATE,
    "last_sync_at" TIMESTAMP(3),
    "last_sync_status" TEXT,
    "last_sync_error" TEXT,
    "next_sync_at" TIMESTAMP(3),
    "failures" INTEGER NOT NULL DEFAULT 0,
    "structure_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meta_ad_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta_ad_entities" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "ad_account_row_id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "campaign_external_id" TEXT,
    "adset_external_id" TEXT,
    "effective_status" TEXT,
    "thumbnail_url" TEXT,
    "preview_url" TEXT,
    "name_history" JSONB NOT NULL DEFAULT '[]',
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meta_ad_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta_ad_insights_daily" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "ad_account_row_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "adset_id" TEXT NOT NULL,
    "ad_id" TEXT NOT NULL,
    "spend" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "link_clicks" INTEGER NOT NULL DEFAULT 0,
    "meta_leads" INTEGER,
    "currency" TEXT NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meta_ad_insights_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta_sync_runs" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "ad_account_row_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "range_from" DATE NOT NULL,
    "range_to" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "rows" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "meta_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_touchpoints" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "channel" TEXT NOT NULL,
    "source" TEXT,
    "medium" TEXT,
    "ad_account_id" TEXT,
    "campaign_id" TEXT,
    "adset_id" TEXT,
    "ad_id" TEXT,
    "form_id" TEXT,
    "meta_lead_id" TEXT,
    "utm" JSONB NOT NULL DEFAULT '{}',
    "landing_url" TEXT,
    "referrer" TEXT,
    "click_ids" JSONB NOT NULL DEFAULT '{}',
    "basis" TEXT NOT NULL DEFAULT 'none',
    "data_source" TEXT NOT NULL,
    "dedupe_key" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_touchpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "meta_ad_accounts_business_id_account_id_key" ON "meta_ad_accounts"("business_id", "account_id");

-- CreateIndex
CREATE INDEX "meta_ad_entities_ad_account_row_id_idx" ON "meta_ad_entities"("ad_account_row_id");

-- CreateIndex
CREATE UNIQUE INDEX "meta_ad_entities_business_id_level_external_id_key" ON "meta_ad_entities"("business_id", "level", "external_id");

-- CreateIndex
CREATE INDEX "meta_ad_insights_daily_business_id_date_idx" ON "meta_ad_insights_daily"("business_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "meta_ad_insights_daily_ad_account_row_id_ad_id_date_key" ON "meta_ad_insights_daily"("ad_account_row_id", "ad_id", "date");

-- CreateIndex
CREATE INDEX "meta_sync_runs_ad_account_row_id_started_at_idx" ON "meta_sync_runs"("ad_account_row_id", "started_at");

-- CreateIndex
CREATE INDEX "lead_touchpoints_business_id_occurred_at_idx" ON "lead_touchpoints"("business_id", "occurred_at");

-- CreateIndex
CREATE INDEX "lead_touchpoints_business_id_contact_id_occurred_at_idx" ON "lead_touchpoints"("business_id", "contact_id", "occurred_at");

-- CreateIndex
CREATE INDEX "lead_touchpoints_business_id_ad_id_idx" ON "lead_touchpoints"("business_id", "ad_id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_touchpoints_business_id_dedupe_key_key" ON "lead_touchpoints"("business_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "meta_ad_accounts" ADD CONSTRAINT "meta_ad_accounts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_ad_accounts" ADD CONSTRAINT "meta_ad_accounts_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "meta_ad_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_ad_entities" ADD CONSTRAINT "meta_ad_entities_ad_account_row_id_fkey" FOREIGN KEY ("ad_account_row_id") REFERENCES "meta_ad_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_ad_insights_daily" ADD CONSTRAINT "meta_ad_insights_daily_ad_account_row_id_fkey" FOREIGN KEY ("ad_account_row_id") REFERENCES "meta_ad_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_sync_runs" ADD CONSTRAINT "meta_sync_runs_ad_account_row_id_fkey" FOREIGN KEY ("ad_account_row_id") REFERENCES "meta_ad_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_touchpoints" ADD CONSTRAINT "lead_touchpoints_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_touchpoints" ADD CONSTRAINT "lead_touchpoints_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_touchpoints" ADD CONSTRAINT "lead_touchpoints_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Carry the existing connection's account over (syncs the last 90 days on the next run).
INSERT INTO "meta_ad_accounts" ("id", "business_id", "connection_id", "account_id", "name", "status", "sync_from", "updated_at")
SELECT 'mac_' || md5(c."id" || c."account_id"), c."business_id", c."id", c."account_id", COALESCE(c."account_name", c."account_id"), 'active', (CURRENT_DATE - 90), now()
FROM "meta_ad_connections" c WHERE c."account_id" IS NOT NULL
ON CONFLICT DO NOTHING;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ultracrm_runtime') THEN
    ALTER TABLE "meta_ad_accounts" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "meta_ad_accounts" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "meta_ad_accounts" TO ultracrm_runtime;
    ALTER TABLE "meta_ad_entities" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "meta_ad_entities" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "meta_ad_entities" TO ultracrm_runtime;
    ALTER TABLE "meta_ad_insights_daily" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "meta_ad_insights_daily" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "meta_ad_insights_daily" TO ultracrm_runtime;
    ALTER TABLE "meta_sync_runs" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "meta_sync_runs" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "meta_sync_runs" TO ultracrm_runtime;
    ALTER TABLE "lead_touchpoints" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "lead_touchpoints" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "lead_touchpoints" TO ultracrm_runtime;
  END IF;
END $$;
