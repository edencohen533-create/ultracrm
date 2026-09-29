-- CreateTable
CREATE TABLE "meta_ad_connections" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "account_name" TEXT NOT NULL,
    "token_sealed" TEXT NOT NULL,
    "verified_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meta_ad_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "meta_ad_connections_business_id_key" ON "meta_ad_connections"("business_id");

-- AddForeignKey
ALTER TABLE "meta_ad_connections" ADD CONSTRAINT "meta_ad_connections_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "meta_ad_connections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "meta_ad_connections" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON "meta_ad_connections" TO ultracrm_runtime;
