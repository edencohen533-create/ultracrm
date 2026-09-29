-- AlterEnum
ALTER TYPE "TelephonyFailureClass" ADD VALUE 'capacity';

-- AlterEnum
ALTER TYPE "TelephonyProvider" ADD VALUE 'zadarma';

-- AlterTable
ALTER TABLE "telephony_provider_health" ADD COLUMN     "closed_at" TIMESTAMP(3),
ADD COLUMN     "trips" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "telephony_routing" ADD COLUMN     "backup_daily_call_limit" INTEGER,
ADD COLUMN     "failover_on_capacity" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "telephony_switch_log" ADD COLUMN     "delivery" JSONB,
ADD COLUMN     "notified_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "telephony_provider_credentials" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "provider" "TelephonyProvider" NOT NULL,
    "secrets" TEXT NOT NULL,
    "sandbox" BOOLEAN NOT NULL DEFAULT false,
    "caller_id_e164" TEXT,
    "caller_id_source" TEXT,
    "caller_id_approved_at" TIMESTAMP(3),
    "caller_id_approved_by_id" TEXT,
    "test_numbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "max_concurrent" INTEGER,
    "last_check_at" TIMESTAMP(3),
    "last_check_ok" BOOLEAN,
    "last_check_detail" JSONB,
    "live_test_passed_at" TIMESTAMP(3),
    "live_test_call_id" TEXT,
    "updated_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telephony_provider_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telephony_agent_endpoints" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" "TelephonyProvider" NOT NULL,
    "extension" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telephony_agent_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "telephony_provider_credentials_business_id_provider_key" ON "telephony_provider_credentials"("business_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "telephony_agent_endpoints_user_id_provider_key" ON "telephony_agent_endpoints"("user_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "telephony_agent_endpoints_business_id_provider_extension_key" ON "telephony_agent_endpoints"("business_id", "provider", "extension");

-- AddForeignKey
ALTER TABLE "telephony_provider_credentials" ADD CONSTRAINT "telephony_provider_credentials_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telephony_agent_endpoints" ADD CONSTRAINT "telephony_agent_endpoints_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation
ALTER TABLE "telephony_provider_credentials" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "telephony_provider_credentials" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON "telephony_provider_credentials" TO ultracrm_runtime;
ALTER TABLE "telephony_agent_endpoints" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "telephony_agent_endpoints" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON "telephony_agent_endpoints" TO ultracrm_runtime;
