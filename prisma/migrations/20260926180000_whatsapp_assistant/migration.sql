-- CreateTable
CREATE TABLE "assistant_links" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "scope" TEXT NOT NULL DEFAULT 'business',
    "code_hash" TEXT,
    "code_expires_at" TIMESTAMP(3),
    "verified_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "last_inbound_at" TIMESTAMP(3),
    "context" JSONB NOT NULL DEFAULT '{}',
    "pending_report" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assistant_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_messages" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "link_id" TEXT,
    "direction" TEXT NOT NULL,
    "inbound_key" TEXT,
    "text" TEXT NOT NULL,
    "intent" TEXT,
    "tools" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'ok',
    "error" TEXT,
    "model" TEXT,
    "latency_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_deliveries" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "link_id" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistant_links_phone_e164_idx" ON "assistant_links"("phone_e164");

-- CreateIndex
CREATE UNIQUE INDEX "assistant_links_business_id_phone_e164_key" ON "assistant_links"("business_id", "phone_e164");

-- CreateIndex
CREATE UNIQUE INDEX "assistant_messages_inbound_key_key" ON "assistant_messages"("inbound_key");

-- CreateIndex
CREATE INDEX "assistant_messages_business_id_created_at_idx" ON "assistant_messages"("business_id", "created_at");

-- CreateIndex
CREATE INDEX "assistant_messages_link_id_created_at_idx" ON "assistant_messages"("link_id", "created_at");

-- CreateIndex
CREATE INDEX "assistant_deliveries_business_id_created_at_idx" ON "assistant_deliveries"("business_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "assistant_deliveries_business_id_key_key" ON "assistant_deliveries"("business_id", "key");

-- AddForeignKey
ALTER TABLE "assistant_links" ADD CONSTRAINT "assistant_links_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_deliveries" ADD CONSTRAINT "assistant_deliveries_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "assistant_links" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "assistant_links" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));

ALTER TABLE "assistant_messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "assistant_messages" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));

ALTER TABLE "assistant_deliveries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "assistant_deliveries" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
