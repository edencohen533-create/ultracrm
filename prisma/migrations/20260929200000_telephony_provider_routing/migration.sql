-- CreateEnum
CREATE TYPE "TelephonyRoutingMode" AS ENUM ('primary_only', 'manual_backup', 'auto_failover');

-- CreateEnum
CREATE TYPE "TelephonyBreakerState" AS ENUM ('closed', 'open', 'half_open');

-- CreateEnum
CREATE TYPE "TelephonyAttemptStatus" AS ENUM ('requested', 'created', 'failed', 'uncertain', 'needs_settlement');

-- CreateEnum
CREATE TYPE "TelephonyFailureClass" AS ENUM ('provider_outage', 'account', 'rate_limit', 'auth', 'invalid_request', 'timeout', 'unknown');

-- CreateTable
CREATE TABLE "telephony_routing" (
    "business_id" TEXT NOT NULL,
    "primary_provider" "TelephonyProvider",
    "backup_provider" "TelephonyProvider",
    "mode" "TelephonyRoutingMode" NOT NULL DEFAULT 'primary_only',
    "manual_active" TEXT NOT NULL DEFAULT 'primary',
    "failure_threshold" INTEGER NOT NULL DEFAULT 5,
    "window_seconds" INTEGER NOT NULL DEFAULT 120,
    "cooldown_seconds" INTEGER NOT NULL DEFAULT 300,
    "probe_calls" INTEGER NOT NULL DEFAULT 3,
    "updated_by_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telephony_routing_pkey" PRIMARY KEY ("business_id")
);

-- CreateTable
CREATE TABLE "telephony_provider_health" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "provider" "TelephonyProvider" NOT NULL,
    "state" "TelephonyBreakerState" NOT NULL DEFAULT 'closed',
    "failures_in_window" INTEGER NOT NULL DEFAULT 0,
    "window_started_at" TIMESTAMP(3),
    "opened_at" TIMESTAMP(3),
    "next_probe_at" TIMESTAMP(3),
    "probe_successes" INTEGER NOT NULL DEFAULT 0,
    "probes_started" INTEGER NOT NULL DEFAULT 0,
    "last_failure_class" "TelephonyFailureClass",
    "last_failure_detail" TEXT,
    "last_failure_at" TIMESTAMP(3),
    "last_success_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telephony_provider_health_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telephony_switch_log" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "from_provider" "TelephonyProvider",
    "to_provider" "TelephonyProvider",
    "kind" TEXT NOT NULL,
    "reason" TEXT,
    "actor_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telephony_switch_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_attempts" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "call_id" TEXT NOT NULL,
    "leg" TEXT NOT NULL,
    "provider" "TelephonyProvider" NOT NULL,
    "provider_account" TEXT,
    "command_key" TEXT NOT NULL,
    "provider_leg_id" TEXT,
    "provider_session_id" TEXT,
    "from_e164" TEXT,
    "to_e164" TEXT,
    "status" "TelephonyAttemptStatus" NOT NULL DEFAULT 'requested',
    "failure_class" "TelephonyFailureClass",
    "failure_detail" TEXT,
    "http_status" INTEGER,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMP(3),
    "settled_at" TIMESTAMP(3),

    CONSTRAINT "call_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telephony_provider_accounts" (
    "id" TEXT NOT NULL,
    "provider" "TelephonyProvider" NOT NULL,
    "account_ref" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMP(3),
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detail" JSONB,

    CONSTRAINT "telephony_provider_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "telephony_provider_health_business_id_provider_key" ON "telephony_provider_health"("business_id", "provider");

-- CreateIndex
CREATE INDEX "telephony_switch_log_business_id_created_at_idx" ON "telephony_switch_log"("business_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "call_attempts_command_key_key" ON "call_attempts"("command_key");

-- CreateIndex
CREATE INDEX "call_attempts_call_id_idx" ON "call_attempts"("call_id");

-- CreateIndex
CREATE INDEX "call_attempts_business_id_requested_at_idx" ON "call_attempts"("business_id", "requested_at");

-- CreateIndex
CREATE INDEX "call_attempts_provider_leg_id_idx" ON "call_attempts"("provider_leg_id");

-- CreateIndex
CREATE UNIQUE INDEX "telephony_provider_accounts_provider_account_ref_key" ON "telephony_provider_accounts"("provider", "account_ref");

-- AddForeignKey
ALTER TABLE "telephony_routing" ADD CONSTRAINT "telephony_routing_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telephony_provider_health" ADD CONSTRAINT "telephony_provider_health_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telephony_switch_log" ADD CONSTRAINT "telephony_switch_log_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Replay sweep for events stored but never processed
CREATE INDEX "telephony_events_processed_at_received_at_idx" ON "telephony_events"("processed_at", "received_at");

-- Tenant isolation (business-scoped tables). telephony_provider_accounts is platform-level (no business_id).
ALTER TABLE "telephony_routing" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "telephony_routing" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON "telephony_routing" TO ultracrm_runtime;
ALTER TABLE "telephony_provider_health" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "telephony_provider_health" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON "telephony_provider_health" TO ultracrm_runtime;
ALTER TABLE "telephony_switch_log" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "telephony_switch_log" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON "telephony_switch_log" TO ultracrm_runtime;
ALTER TABLE "call_attempts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "call_attempts" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON "call_attempts" TO ultracrm_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "telephony_provider_accounts" TO ultracrm_runtime;
