-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "list_ids" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "templates" ADD COLUMN     "internal" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "campaign_drafts" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "channel" "Channel" NOT NULL DEFAULT 'email',
    "name" TEXT NOT NULL,
    "step" TEXT NOT NULL DEFAULT 'info',
    "data" JSONB NOT NULL DEFAULT '{}',
    "template_id" TEXT,
    "campaign_id" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaign_drafts_business_id_channel_updated_at_idx" ON "campaign_drafts"("business_id", "channel", "updated_at");

-- AddForeignKey
ALTER TABLE "campaign_drafts" ADD CONSTRAINT "campaign_drafts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_drafts" ADD CONSTRAINT "campaign_drafts_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: every existing campaign has exactly its primary list.
UPDATE "campaigns" SET "list_ids" = jsonb_build_array("list_id") WHERE "list_ids" = '[]'::jsonb;

-- Tenant isolation for the new table.
ALTER TABLE "campaign_drafts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "campaign_drafts" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
