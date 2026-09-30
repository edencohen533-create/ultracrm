-- Store connection health / sync (additive).
ALTER TABLE "store_connections" ADD COLUMN "api_status" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "store_connections" ADD COLUMN "api_checked_at" TIMESTAMP(3);
ALTER TABLE "store_connections" ADD COLUMN "api_error" TEXT;
ALTER TABLE "store_connections" ADD COLUMN "api_access" JSONB;
ALTER TABLE "store_connections" ADD COLUMN "webhook_status" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "store_connections" ADD COLUMN "webhook_error" TEXT;
ALTER TABLE "store_connections" ADD COLUMN "last_verified_event_at" TIMESTAMP(3);
ALTER TABLE "store_connections" ADD COLUMN "sync_state" JSONB;
ALTER TABLE "store_connections" ADD COLUMN "last_sync_at" TIMESTAMP(3);
ALTER TABLE "store_connections" ADD COLUMN "last_sync_error" TEXT;
ALTER TABLE "store_connections" ADD COLUMN "capabilities" JSONB;
ALTER TABLE "store_connections" ADD COLUMN "disconnected_at" TIMESTAMP(3);
-- A store that already received events had its webhooks configured; a signed event proves them.
UPDATE "store_connections" SET "webhook_status" = 'verified', "last_verified_event_at" = "last_event_at" WHERE "last_event_at" IS NOT NULL;

-- Order snapshots: totals, payment confirmation, addresses, documents, source version, import flag.
ALTER TABLE "store_orders" ADD COLUMN "totals" JSONB;
ALTER TABLE "store_orders" ADD COLUMN "payment" JSONB;
ALTER TABLE "store_orders" ADD COLUMN "addresses" JSONB;
ALTER TABLE "store_orders" ADD COLUMN "documents" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "store_orders" ADD COLUMN "source_modified_at" TIMESTAMP(3);
ALTER TABLE "store_orders" ADD COLUMN "imported" BOOLEAN NOT NULL DEFAULT false;
-- Order ids are unique per STORE (two stores of one business may both have order #100).
UPDATE "store_orders" SET "external_id" = "store_id" || ':' || "external_id"
  WHERE "source" IN ('woocommerce', 'shopify') AND "store_id" IS NOT NULL AND "external_id" NOT LIKE "store_id" || ':%';

CREATE TABLE "store_events" (
  "id" TEXT NOT NULL, "business_id" TEXT NOT NULL, "store_id" TEXT NOT NULL, "source" TEXT NOT NULL, "topic" TEXT NOT NULL,
  "resource_id" TEXT, "delivery_id" TEXT, "payload_hash" TEXT NOT NULL, "payload" JSONB NOT NULL, "source_modified_at" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'pending', "attempts" INTEGER NOT NULL DEFAULT 0, "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "error" TEXT, "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "processed_at" TIMESTAMP(3),
  CONSTRAINT "store_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "store_events_store_id_payload_hash_key" ON "store_events"("store_id", "payload_hash");
CREATE INDEX "store_events_status_next_attempt_at_idx" ON "store_events"("status", "next_attempt_at");
CREATE INDEX "store_events_business_id_store_id_received_at_idx" ON "store_events"("business_id", "store_id", "received_at");
ALTER TABLE "store_events" ADD CONSTRAINT "store_events_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "store_customers" (
  "id" TEXT NOT NULL, "business_id" TEXT NOT NULL, "store_id" TEXT NOT NULL, "external_id" TEXT NOT NULL, "contact_id" TEXT,
  "email" TEXT, "phone_e164" TEXT, "name" TEXT, "link_state" TEXT NOT NULL DEFAULT 'linked', "source_modified_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "store_customers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "store_customers_store_id_external_id_key" ON "store_customers"("store_id", "external_id");
CREATE INDEX "store_customers_business_id_contact_id_idx" ON "store_customers"("business_id", "contact_id");
ALTER TABLE "store_customers" ADD CONSTRAINT "store_customers_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "store_products" (
  "id" TEXT NOT NULL, "business_id" TEXT NOT NULL, "store_id" TEXT NOT NULL, "external_id" TEXT NOT NULL, "parent_external_id" TEXT,
  "name" TEXT NOT NULL, "sku" TEXT, "type" TEXT, "status" TEXT, "price" DECIMAL(14,2), "components" JSONB, "deleted" BOOLEAN NOT NULL DEFAULT false,
  "source_modified_at" TIMESTAMP(3), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "store_products_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "store_products_store_id_external_id_key" ON "store_products"("store_id", "external_id");
CREATE INDEX "store_products_business_id_name_idx" ON "store_products"("business_id", "name");
ALTER TABLE "store_products" ADD CONSTRAINT "store_products_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ultracrm_runtime') THEN
    ALTER TABLE "store_events" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "store_events" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "store_events" TO ultracrm_runtime;
    ALTER TABLE "store_customers" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "store_customers" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "store_customers" TO ultracrm_runtime;
    ALTER TABLE "store_products" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "store_products" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "store_products" TO ultracrm_runtime;
  END IF;
END $$;
