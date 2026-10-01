-- CreateTable
CREATE TABLE "meta_capi_connections" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "dataset_id" TEXT NOT NULL,
    "dataset_name" TEXT,
    "token_sealed" TEXT NOT NULL,
    "token_hint" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "test_event_code" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unverified',
    "last_error" TEXT,
    "last_checked_at" TIMESTAMP(3),
    "lead_event_source" TEXT NOT NULL DEFAULT 'UltraCRM',
    "site_sends_purchase" BOOLEAN NOT NULL DEFAULT false,
    "connected_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meta_capi_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta_capi_rules" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "trigger_config" JSONB NOT NULL DEFAULT '{}',
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "event_kind" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "action_source" TEXT NOT NULL,
    "value_source" TEXT NOT NULL DEFAULT 'none',
    "value_field" TEXT,
    "fixed_value" DECIMAL(14,2),
    "currency" TEXT,
    "value_includes" JSONB NOT NULL DEFAULT '{}',
    "resend" TEXT NOT NULL DEFAULT 'once',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meta_capi_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta_capi_events" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "rule_id" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "contact_id" TEXT,
    "value" DECIMAL(14,2),
    "currency" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "status_reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "last_error" TEXT,
    "test_code" TEXT,
    "fbtrace_id" TEXT,
    "received_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meta_capi_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "title" TEXT NOT NULL DEFAULT 'פגישה',
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "rescheduled_count" INTEGER NOT NULL DEFAULT 0,
    "attended_at" TIMESTAMP(3),
    "owner_user_id" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "meta_capi_connections_business_id_key" ON "meta_capi_connections"("business_id");

-- CreateIndex
CREATE INDEX "meta_capi_rules_business_id_trigger_enabled_idx" ON "meta_capi_rules"("business_id", "trigger", "enabled");

-- CreateIndex
CREATE INDEX "meta_capi_events_business_id_status_next_attempt_at_idx" ON "meta_capi_events"("business_id", "status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "meta_capi_events_business_id_created_at_idx" ON "meta_capi_events"("business_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "meta_capi_events_business_id_dedupe_key_key" ON "meta_capi_events"("business_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "appointments_business_id_contact_id_idx" ON "appointments"("business_id", "contact_id");

-- CreateIndex
CREATE INDEX "appointments_business_id_scheduled_at_idx" ON "appointments"("business_id", "scheduled_at");

-- AddForeignKey
ALTER TABLE "meta_capi_connections" ADD CONSTRAINT "meta_capi_connections_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_capi_rules" ADD CONSTRAINT "meta_capi_rules_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_capi_events" ADD CONSTRAINT "meta_capi_events_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_capi_events" ADD CONSTRAINT "meta_capi_events_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "meta_capi_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ultracrm_runtime') THEN
    ALTER TABLE "meta_capi_connections" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "meta_capi_connections" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "meta_capi_connections" TO ultracrm_runtime;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ultracrm_runtime') THEN
    ALTER TABLE "meta_capi_rules" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "meta_capi_rules" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "meta_capi_rules" TO ultracrm_runtime;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ultracrm_runtime') THEN
    ALTER TABLE "meta_capi_events" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "meta_capi_events" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "meta_capi_events" TO ultracrm_runtime;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ultracrm_runtime') THEN
    ALTER TABLE "appointments" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "appointments" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "appointments" TO ultracrm_runtime;
  END IF;
END $$;

