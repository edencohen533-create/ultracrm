-- Additive: soft delete for contacts (history kept, details scrubbed) and a sending window per campaign.
ALTER TABLE "contacts" ADD COLUMN "deleted_at" TIMESTAMP(3);
CREATE INDEX "contacts_business_id_deleted_at_idx" ON "contacts"("business_id") WHERE "deleted_at" IS NULL;
-- Existing campaigns keep their behaviour: no window of their own → the business's default window.
ALTER TABLE "campaigns" ADD COLUMN "send_window" JSONB;
