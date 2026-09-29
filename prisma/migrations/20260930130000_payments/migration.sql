-- In-call payments: provider connections, payment requests, provider events (per business, RLS). Additive only.
CREATE TABLE "payment_provider_connections" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'test',
    "label" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_error" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_provider_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_requests" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "call_id" TEXT,
    "agent_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT,
    "description" TEXT NOT NULL,
    "amount_agorot" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "list_amount_agorot" INTEGER,
    "amount_edited_by_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'created',
    "idempotency_key" TEXT NOT NULL,
    "provider_request_id" TEXT,
    "payment_url" TEXT,
    "provider_transaction_id" TEXT,
    "approval_number" TEXT,
    "receipt_url" TEXT,
    "failure_reason" TEXT,
    "late_confirmation" BOOLEAN NOT NULL DEFAULT false,
    "sent_via" TEXT,
    "last_checked_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_events" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "event_key" TEXT NOT NULL,
    "payment_request_id" TEXT,
    "kind" TEXT NOT NULL,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "payment_provider_connections_business_id_is_active_idx" ON "payment_provider_connections"("business_id", "is_active");

CREATE INDEX "payment_requests_business_id_contact_id_idx" ON "payment_requests"("business_id", "contact_id");

CREATE INDEX "payment_requests_call_id_idx" ON "payment_requests"("call_id");

CREATE UNIQUE INDEX "payment_requests_business_id_idempotency_key_key" ON "payment_requests"("business_id", "idempotency_key");

CREATE UNIQUE INDEX "payment_requests_provider_provider_request_id_key" ON "payment_requests"("provider", "provider_request_id");

CREATE INDEX "payment_events_payment_request_id_idx" ON "payment_events"("payment_request_id");

CREATE UNIQUE INDEX "payment_events_provider_event_key_key" ON "payment_events"("provider", "event_key");

ALTER TABLE "payment_provider_connections" ADD CONSTRAINT "payment_provider_connections_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "payment_provider_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "payment_provider_connections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "payment_provider_connections" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON "payment_provider_connections" TO ultracrm_runtime;
ALTER TABLE "payment_requests" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "payment_requests" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON "payment_requests" TO ultracrm_runtime;
ALTER TABLE "payment_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "payment_events" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON "payment_events" TO ultracrm_runtime;
