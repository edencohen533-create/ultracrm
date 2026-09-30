-- External CRM connectors: connections, external record identity, inbound event log, write-back outbox, review queue;
-- scoped / rotatable / rate-limited integration keys. Additive only.

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "connection_id" TEXT,
ADD COLUMN     "expires_at" TIMESTAMP(3),
ADD COLUMN     "rotated_from_id" TEXT,
ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "window_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "window_start" TIMESTAMP(3);
-- CreateTable
CREATE TABLE "crm_connections" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "connector_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'setup',
    "auth_config" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "verified_at" TIMESTAMP(3),
    "last_test_at" TIMESTAMP(3),
    "last_test_result" JSONB,
    "last_sync_at" TIMESTAMP(3),
    "last_sync_status" TEXT,
    "last_error" TEXT,
    "sync_state" JSONB NOT NULL DEFAULT '{}',
    "next_sync_at" TIMESTAMP(3),
    "created_by_id" TEXT,
    "disconnected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_connections_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "external_record_links" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "record_type" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "local_id" TEXT,
    "source_updated_at" TIMESTAMP(3),
    "source_version" TEXT,
    "last_synced_at" TIMESTAMP(3),
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMP(3),
    "last_outbound" JSONB NOT NULL DEFAULT '{}',
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_record_links_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "crm_sync_events" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "record_type" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "correlation_id" TEXT,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_sync_events_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "crm_outbox" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "local_type" TEXT NOT NULL,
    "local_id" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "external_ref" TEXT,
    "correlation_id" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_outbox_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "crm_review_items" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "record_type" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "local_id" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "resolved_by_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_review_items_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "crm_connections_business_id_idx" ON "crm_connections"("business_id");
-- CreateIndex
CREATE INDEX "external_record_links_business_id_record_type_local_id_idx" ON "external_record_links"("business_id", "record_type", "local_id");
-- CreateIndex
CREATE UNIQUE INDEX "external_record_links_business_id_connection_id_record_type_key" ON "external_record_links"("business_id", "connection_id", "record_type", "external_id");
-- CreateIndex
CREATE INDEX "crm_sync_events_business_id_status_created_at_idx" ON "crm_sync_events"("business_id", "status", "created_at");
-- CreateIndex
CREATE UNIQUE INDEX "crm_sync_events_connection_id_event_id_key" ON "crm_sync_events"("connection_id", "event_id");
-- CreateIndex
CREATE INDEX "crm_outbox_business_id_status_next_attempt_at_idx" ON "crm_outbox"("business_id", "status", "next_attempt_at");
-- CreateIndex
CREATE UNIQUE INDEX "crm_outbox_connection_id_dedupe_key_key" ON "crm_outbox"("connection_id", "dedupe_key");
-- CreateIndex
CREATE INDEX "crm_review_items_business_id_status_idx" ON "crm_review_items"("business_id", "status");
-- CreateIndex
CREATE UNIQUE INDEX "crm_review_items_connection_id_kind_record_type_external_id_key" ON "crm_review_items"("connection_id", "kind", "record_type", "external_id");
-- AddForeignKey
ALTER TABLE "crm_connections" ADD CONSTRAINT "crm_connections_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "external_record_links" ADD CONSTRAINT "external_record_links_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "crm_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "crm_sync_events" ADD CONSTRAINT "crm_sync_events_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "crm_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "crm_outbox" ADD CONSTRAINT "crm_outbox_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "crm_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "crm_review_items" ADD CONSTRAINT "crm_review_items_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "crm_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ultracrm_runtime') THEN
    ALTER TABLE "crm_connections" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "crm_connections" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_connections" TO ultracrm_runtime;
    ALTER TABLE "external_record_links" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "external_record_links" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "external_record_links" TO ultracrm_runtime;
    ALTER TABLE "crm_sync_events" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "crm_sync_events" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_sync_events" TO ultracrm_runtime;
    ALTER TABLE "crm_outbox" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "crm_outbox" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_outbox" TO ultracrm_runtime;
    ALTER TABLE "crm_review_items" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "crm_review_items" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_review_items" TO ultracrm_runtime;
  END IF;
END $$;
