-- AlterEnum
ALTER TYPE "SequenceTrigger" ADD VALUE 'CART_ABANDONED';

-- CreateTable
CREATE TABLE "store_connections" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "public_key" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "abandon_after_minutes" INTEGER NOT NULL DEFAULT 60,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_event_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carts" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "contact_id" TEXT,
    "email" TEXT,
    "phone_e164" TEXT,
    "customer_name" TEXT,
    "currency" TEXT,
    "total" DECIMAL(14,2),
    "items" JSONB NOT NULL DEFAULT '[]',
    "checkout_url" TEXT,
    "accepts_marketing" BOOLEAN,
    "status" TEXT NOT NULL DEFAULT 'open',
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "abandoned_at" TIMESTAMP(3),
    "converted_at" TIMESTAMP(3),
    "order_id" TEXT,
    "order_total" DECIMAL(14,2),
    "recovery_message_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "carts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "store_connections_public_key_key" ON "store_connections"("public_key");

-- CreateIndex
CREATE INDEX "store_connections_business_id_idx" ON "store_connections"("business_id");

-- CreateIndex
CREATE INDEX "carts_business_id_status_last_activity_at_idx" ON "carts"("business_id", "status", "last_activity_at");

-- CreateIndex
CREATE INDEX "carts_contact_id_idx" ON "carts"("contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "carts_store_id_external_id_key" ON "carts"("store_id", "external_id");

-- AddForeignKey
ALTER TABLE "store_connections" ADD CONSTRAINT "store_connections_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;


ALTER TABLE "store_connections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "store_connections" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
ALTER TABLE "carts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "carts" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
