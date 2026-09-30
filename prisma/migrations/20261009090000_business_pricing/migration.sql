-- Custom pricing per business (platform admin): append-only versions + one-time credits. Additive only.
CREATE TABLE "business_pricing" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "license_prices" JSONB NOT NULL DEFAULT '{}',
    "discount" JSONB,
    "usage_rates" JSONB NOT NULL DEFAULT '{}',
    "note" TEXT,
    "created_by_account_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "business_pricing_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "business_pricing_business_id_version_key" ON "business_pricing"("business_id", "version");
CREATE INDEX "business_pricing_business_id_effective_from_idx" ON "business_pricing"("business_id", "effective_from");

CREATE TABLE "billing_credits" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "remaining_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "reason" TEXT NOT NULL,
    "applied" JSONB NOT NULL DEFAULT '[]',
    "created_by_account_id" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "billing_credits_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_credits_amount_check" CHECK ("amount_minor" > 0 AND "remaining_minor" >= 0 AND "remaining_minor" <= "amount_minor")
);
CREATE INDEX "billing_credits_business_id_cancelled_at_idx" ON "billing_credits"("business_id", "cancelled_at");

-- Versions are never edited (a change is a new version).
CREATE OR REPLACE FUNCTION business_pricing_frozen() RETURNS trigger AS $f$
BEGIN RAISE EXCEPTION 'business pricing versions are append-only – create a new version'; END $f$ LANGUAGE plpgsql;
CREATE TRIGGER business_pricing_no_update BEFORE UPDATE ON "business_pricing" FOR EACH ROW EXECUTE FUNCTION business_pricing_frozen();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ultracrm_runtime') THEN
    ALTER TABLE "business_pricing" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "business_pricing" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "business_pricing" TO ultracrm_runtime;
    ALTER TABLE "billing_credits" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "billing_credits" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "billing_credits" TO ultracrm_runtime;
  END IF;
END $$;
