-- CreateTable
CREATE TABLE "sales_offers" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "unit_amount" INTEGER NOT NULL,
    "unit_cost" INTEGER,
    "tax_bps" INTEGER NOT NULL DEFAULT 0,
    "max_discount_bps" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_quotes" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "subtotal" INTEGER NOT NULL,
    "tax" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "terms" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'approved',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "token_hash" TEXT,
    "shared_at" TIMESTAMP(3),
    "viewed_at" TIMESTAMP(3),
    "accepted_at" TIMESTAMP(3),
    "accepted_name" TEXT,
    "participants" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_offers_business_id_active_idx" ON "sales_offers"("business_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "sales_quotes_token_hash_key" ON "sales_quotes"("token_hash");

-- CreateIndex
CREATE INDEX "sales_quotes_business_id_lead_id_created_at_idx" ON "sales_quotes"("business_id", "lead_id", "created_at");

-- CreateIndex
CREATE INDEX "sales_quotes_business_id_status_idx" ON "sales_quotes"("business_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sales_quotes_business_id_family_id_revision_key" ON "sales_quotes"("business_id", "family_id", "revision");

-- AddForeignKey
ALTER TABLE "sales_offers" ADD CONSTRAINT "sales_offers_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_quotes" ADD CONSTRAINT "sales_quotes_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_quotes" ADD CONSTRAINT "sales_quotes_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "sales_offers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales_offers" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
ALTER TABLE "sales_quotes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales_quotes" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON "sales_offers", "sales_quotes" TO ultracrm_runtime;
ALTER TABLE "sales_offers" ADD CONSTRAINT sales_offer_amounts CHECK (unit_amount >= 0 AND (unit_cost IS NULL OR unit_cost >= 0) AND tax_bps BETWEEN 0 AND 10000 AND max_discount_bps BETWEEN 0 AND 10000);
ALTER TABLE "sales_quotes" ADD CONSTRAINT sales_quote_amounts CHECK (subtotal >= 0 AND tax >= 0 AND total = subtotal + tax AND revision > 0);
