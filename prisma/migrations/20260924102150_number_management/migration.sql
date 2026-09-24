-- AlterTable
ALTER TABLE "calls" ADD COLUMN     "number_selection_reason" TEXT;

-- AlterTable
ALTER TABLE "dial_lists" ADD COLUMN     "number_policy" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "phone_numbers" ADD COLUMN     "assigned_user_id" TEXT,
ADD COLUMN     "callback_user_id" TEXT,
ADD COLUMN     "costs" JSONB,
ADD COLUMN     "last_selected_at" TIMESTAMP(3),
ADD COLUMN     "max_concurrent" INTEGER,
ADD COLUMN     "max_daily_attempts" INTEGER,
ADD COLUMN     "outbound_paused" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "provider_data" JSONB,
ADD COLUMN     "provider_number_id" TEXT,
ADD COLUMN     "reputation_checked_at" TIMESTAMP(3),
ADD COLUMN     "reputation_data" JSONB,
ADD COLUMN     "reputation_review" TEXT,
ADD COLUMN     "reputation_source" TEXT NOT NULL DEFAULT 'truecaller',
ADD COLUMN     "reputation_status" TEXT NOT NULL DEFAULT 'unsupported',
ADD COLUMN     "verification_status" TEXT NOT NULL DEFAULT 'unverified',
ADD COLUMN     "verified_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "number_connections" (
    "business_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unverified',
    "checked_at" TIMESTAMP(3),
    "error" TEXT,
    "fingerprint" TEXT,

    CONSTRAINT "number_connections_pkey" PRIMARY KEY ("business_id")
);

-- CreateTable
CREATE TABLE "number_orders" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'telnyx',
    "e164" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'quoted',
    "quote" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "confirmed_by" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "provider_order_id" TEXT,
    "provider_status" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "number_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "number_orders_business_id_created_at_idx" ON "number_orders"("business_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "number_orders_business_id_provider_e164_key" ON "number_orders"("business_id", "provider", "e164");

-- CreateIndex
CREATE INDEX "calls_business_id_phone_number_id_created_at_idx" ON "calls"("business_id", "phone_number_id", "created_at");

-- AddForeignKey
ALTER TABLE "number_connections" ADD CONSTRAINT "number_connections_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "number_orders" ADD CONSTRAINT "number_orders_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
