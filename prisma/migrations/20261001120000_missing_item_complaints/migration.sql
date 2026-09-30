-- Order snapshots (items as sold, changes, shipments, receipt) and checked customer complaints (additive).
CREATE TABLE "store_orders" (
  "id" TEXT NOT NULL,
  "business_id" TEXT NOT NULL,
  "store_id" TEXT,
  "contact_id" TEXT,
  "source" TEXT NOT NULL,
  "external_id" TEXT NOT NULL,
  "order_number" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "phone_e164" TEXT,
  "email" TEXT,
  "currency" TEXT,
  "total" DECIMAL(14,2),
  "placed_at" TIMESTAMP(3),
  "items" JSONB NOT NULL DEFAULT '[]',
  "changes" JSONB NOT NULL DEFAULT '[]',
  "shipments" JSONB NOT NULL DEFAULT '[]',
  "receipt" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "store_orders_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "store_orders_business_id_source_external_id_key" ON "store_orders"("business_id", "source", "external_id");
CREATE INDEX "store_orders_business_id_contact_id_placed_at_idx" ON "store_orders"("business_id", "contact_id", "placed_at");
CREATE INDEX "store_orders_business_id_phone_e164_idx" ON "store_orders"("business_id", "phone_e164");
ALTER TABLE "store_orders" ADD CONSTRAINT "store_orders_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "store_orders" ADD CONSTRAINT "store_orders_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "service_cases" (
  "id" TEXT NOT NULL,
  "business_id" TEXT NOT NULL,
  "contact_id" TEXT NOT NULL,
  "conversation_id" TEXT,
  "order_id" TEXT,
  "kind" TEXT NOT NULL DEFAULT 'missing_item',
  "finding" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "claim" JSONB NOT NULL,
  "summary" TEXT NOT NULL,
  "sources" JSONB NOT NULL DEFAULT '[]',
  "suggested_reply" TEXT,
  "dedupe_key" TEXT NOT NULL,
  "created_by" TEXT NOT NULL DEFAULT 'ai',
  "resolved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "service_cases_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "service_cases_business_id_dedupe_key_key" ON "service_cases"("business_id", "dedupe_key");
CREATE INDEX "service_cases_business_id_contact_id_created_at_idx" ON "service_cases"("business_id", "contact_id", "created_at");
ALTER TABLE "service_cases" ADD CONSTRAINT "service_cases_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_cases" ADD CONSTRAINT "service_cases_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_cases" ADD CONSTRAINT "service_cases_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "store_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tenant isolation (same as every business table).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ultracrm_runtime') THEN
    ALTER TABLE "store_orders" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "store_orders" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "store_orders" TO ultracrm_runtime;
    ALTER TABLE "service_cases" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "service_cases" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "service_cases" TO ultracrm_runtime;
  END IF;
END $$;
