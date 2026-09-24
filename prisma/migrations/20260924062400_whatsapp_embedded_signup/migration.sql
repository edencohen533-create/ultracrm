-- CreateEnum
CREATE TYPE "WaConnectionStatus" AS ENUM ('disconnected', 'in_progress', 'needs_action', 'connected_not_ready', 'connected', 'revoked', 'error');

-- AlterTable
ALTER TABLE "provider_credentials" ADD COLUMN     "code_verification_status" TEXT,
ADD COLUMN     "connection_method" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN     "granted_scopes" JSONB,
ADD COLUMN     "last_outbound_test_at" TIMESTAMP(3),
ADD COLUMN     "meta_business_id" TEXT,
ADD COLUMN     "name_status" TEXT,
ADD COLUMN     "platform_type" TEXT,
ADD COLUMN     "quality_rating" TEXT,
ADD COLUMN     "registered_at" TIMESTAMP(3),
ADD COLUMN     "status" "WaConnectionStatus" NOT NULL DEFAULT 'disconnected',
ADD COLUMN     "subscribed_at" TIMESTAMP(3),
ADD COLUMN     "token_checked_at" TIMESTAMP(3),
ADD COLUMN     "verified_name" TEXT,
ADD COLUMN     "waba_id" TEXT,
ADD COLUMN     "waba_name" TEXT;

-- CreateTable
CREATE TABLE "whatsapp_signup_sessions" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'started',
    "step" TEXT,
    "code_hash" TEXT,
    "waba_id" TEXT,
    "phone_number_id" TEXT,
    "meta_business_id" TEXT,
    "credential_id" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_signup_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_signup_sessions_state_key" ON "whatsapp_signup_sessions"("state");

-- CreateIndex
CREATE INDEX "whatsapp_signup_sessions_business_id_status_created_at_idx" ON "whatsapp_signup_sessions"("business_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "provider_credentials_waba_id_idx" ON "provider_credentials"("waba_id");

-- AddForeignKey
ALTER TABLE "whatsapp_signup_sessions" ADD CONSTRAINT "whatsapp_signup_sessions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_signup_sessions" ADD CONSTRAINT "whatsapp_signup_sessions_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "provider_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
