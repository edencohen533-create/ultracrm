-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "deletion_requested_at" TIMESTAMP(3),
ADD COLUMN     "deletion_requested_by_id" TEXT,
ADD COLUMN     "deletion_scheduled_for" TIMESTAMP(3);

-- AlterTable

-- AlterTable
ALTER TABLE "provider_credentials" ADD COLUMN     "messaging_limit_tier" TEXT,
ADD COLUMN     "meta_user_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "meta_deletion_requests" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "confirmation_code" TEXT NOT NULL,
    "meta_user_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "business_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "meta_deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_requests" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "business_name" TEXT,
    "topic" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "lang" TEXT NOT NULL DEFAULT 'he',
    "ip_hash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "meta_deletion_requests_confirmation_code_key" ON "meta_deletion_requests"("confirmation_code");

-- CreateIndex
CREATE INDEX "support_requests_created_at_idx" ON "support_requests"("created_at");

