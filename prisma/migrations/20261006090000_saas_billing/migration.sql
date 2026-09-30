-- SaaS commercial readiness: versioned price book, subscriptions + documents + provider events, append-only usage
-- ledger, budget caps + reservations, platform alerts, in-app support tickets, ops drills, provider reconciliation.
-- Additive only.

-- CreateTable
CREATE TABLE "price_book_versions" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "license_items" JSONB NOT NULL,
    "usage_rates" JSONB NOT NULL DEFAULT '[]',
    "tax_rate_bps" INTEGER NOT NULL DEFAULT 1800,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "published_at" TIMESTAMP(3),
    "created_by_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_book_versions_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'none',
    "price_book_version_id" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'sandbox',
    "provider_customer_id" TEXT,
    "payment_method_ref" TEXT,
    "payment_method_label" TEXT,
    "current_period_start" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "canceled_at" TIMESTAMP(3),
    "grace_until" TIMESTAMP(3),
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "next_retry_at" TIMESTAMP(3),
    "last_event_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "subscription_items" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "pending_quantity" INTEGER,
    "unit_price_minor" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_items_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "billing_documents" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "period_start" TIMESTAMP(3),
    "period_end" TIMESTAMP(3),
    "lines" JSONB NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "subtotal_minor" INTEGER NOT NULL,
    "tax_minor" INTEGER NOT NULL,
    "total_minor" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "effect" JSONB NOT NULL DEFAULT '{}',
    "idempotency_key" TEXT NOT NULL,
    "provider_payment_ref" TEXT,
    "checkout_url" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "corrects_document_id" TEXT,

    CONSTRAINT "billing_documents_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "billing_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "business_id" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "result" TEXT,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "usage_events" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "user_id" TEXT,
    "module" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "provider" TEXT,
    "provider_ref" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'charge',
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "unit" TEXT NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "billed_quantity" DECIMAL(18,6),
    "price_book_version" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "provider_cost_minor" INTEGER,
    "provider_currency" TEXT,
    "price_minor" INTEGER,
    "status" TEXT NOT NULL,
    "billed_by_provider" BOOLEAN NOT NULL DEFAULT false,
    "corrects_event_id" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "budget_policies" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "monthly_cap_minor" INTEGER,
    "alert_percents" INTEGER[] DEFAULT ARRAY[50, 80, 100]::INTEGER[],
    "hard_stop" BOOLEAN NOT NULL DEFAULT true,
    "alerts_sent" JSONB NOT NULL DEFAULT '{}',
    "updated_by_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_policies_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "budget_reservations" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'held',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_reservations_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "platform_alerts" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "business_id" TEXT,
    "title" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "count" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "platform_alerts_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "ops_drills" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3) NOT NULL,
    "performed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_drills_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "reconciliation_runs" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "reconciliation_items" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider_ref" TEXT,
    "business_id" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'open',

    CONSTRAINT "reconciliation_items_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "price_book_versions_version_key" ON "price_book_versions"("version");
-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_business_id_key" ON "subscriptions"("business_id");
-- CreateIndex
CREATE UNIQUE INDEX "subscription_items_subscription_id_code_key" ON "subscription_items"("subscription_id", "code");
-- CreateIndex
CREATE UNIQUE INDEX "billing_documents_number_key" ON "billing_documents"("number");
-- CreateIndex
CREATE INDEX "billing_documents_business_id_issued_at_idx" ON "billing_documents"("business_id", "issued_at");
-- CreateIndex
CREATE UNIQUE INDEX "billing_documents_business_id_idempotency_key_key" ON "billing_documents"("business_id", "idempotency_key");
-- CreateIndex
CREATE UNIQUE INDEX "billing_events_provider_event_id_key" ON "billing_events"("provider", "event_id");
-- CreateIndex
CREATE INDEX "usage_events_business_id_occurred_at_idx" ON "usage_events"("business_id", "occurred_at");
-- CreateIndex
CREATE INDEX "usage_events_business_id_module_occurred_at_idx" ON "usage_events"("business_id", "module", "occurred_at");
-- CreateIndex
CREATE UNIQUE INDEX "usage_events_business_id_idempotency_key_key" ON "usage_events"("business_id", "idempotency_key");
-- CreateIndex
CREATE UNIQUE INDEX "budget_policies_business_id_key" ON "budget_policies"("business_id");
-- CreateIndex
CREATE INDEX "budget_reservations_business_id_status_idx" ON "budget_reservations"("business_id", "status");
-- CreateIndex
CREATE UNIQUE INDEX "budget_reservations_business_id_key_key" ON "budget_reservations"("business_id", "key");
-- CreateIndex
CREATE UNIQUE INDEX "platform_alerts_fingerprint_key" ON "platform_alerts"("fingerprint");
-- CreateIndex
CREATE INDEX "platform_alerts_status_last_seen_at_idx" ON "platform_alerts"("status", "last_seen_at");
-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_code_key" ON "support_tickets"("code");
-- CreateIndex
CREATE INDEX "support_tickets_business_id_created_at_idx" ON "support_tickets"("business_id", "created_at");
-- CreateIndex
CREATE INDEX "reconciliation_items_run_id_kind_idx" ON "reconciliation_items"("run_id", "kind");
-- AddForeignKey
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "billing_documents" ADD CONSTRAINT "billing_documents_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "reconciliation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The usage ledger is append-only: corrections are new rows. Only an explicit, audited retention purge may delete.
CREATE OR REPLACE FUNCTION usage_events_append_only() RETURNS trigger AS $f$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.allow_usage_purge', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'usage_events is append-only (use an adjustment / credit row)';
END $f$ LANGUAGE plpgsql;
CREATE TRIGGER usage_events_no_update BEFORE UPDATE OR DELETE ON "usage_events" FOR EACH ROW EXECUTE FUNCTION usage_events_append_only();

-- A billing document's number, lines and amounts are frozen once issued (a correction is a credit document).
CREATE OR REPLACE FUNCTION billing_documents_frozen() RETURNS trigger AS $f$
BEGIN
  IF NEW.number <> OLD.number OR NEW.lines::text <> OLD.lines::text OR NEW.subtotal_minor <> OLD.subtotal_minor OR NEW.tax_minor <> OLD.tax_minor OR NEW.total_minor <> OLD.total_minor OR NEW.currency <> OLD.currency OR NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'billing document % is frozen – issue a credit document instead', OLD.number;
  END IF;
  RETURN NEW;
END $f$ LANGUAGE plpgsql;
CREATE TRIGGER billing_documents_no_edit BEFORE UPDATE ON "billing_documents" FOR EACH ROW EXECUTE FUNCTION billing_documents_frozen();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ultracrm_runtime') THEN
    ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "subscriptions" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "subscriptions" TO ultracrm_runtime;
    ALTER TABLE "subscription_items" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "subscription_items" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "subscription_items" TO ultracrm_runtime;
    ALTER TABLE "billing_documents" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "billing_documents" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "billing_documents" TO ultracrm_runtime;
    ALTER TABLE "billing_events" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "billing_events" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "billing_events" TO ultracrm_runtime;
    ALTER TABLE "usage_events" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "usage_events" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "usage_events" TO ultracrm_runtime;
    ALTER TABLE "budget_policies" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "budget_policies" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "budget_policies" TO ultracrm_runtime;
    ALTER TABLE "budget_reservations" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "budget_reservations" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "budget_reservations" TO ultracrm_runtime;
    ALTER TABLE "platform_alerts" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "platform_alerts" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_alerts" TO ultracrm_runtime;
    ALTER TABLE "support_tickets" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "support_tickets" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "support_tickets" TO ultracrm_runtime;
    ALTER TABLE "reconciliation_items" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "reconciliation_items" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "reconciliation_items" TO ultracrm_runtime;
  END IF;
END $$;
