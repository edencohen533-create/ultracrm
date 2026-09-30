-- Existing customers vs. new prospects (additive).
ALTER TABLE "dial_lists" ADD COLUMN "audience" TEXT NOT NULL DEFAULT 'new_prospects';
ALTER TABLE "dial_lists" ADD CONSTRAINT "dial_lists_audience_check" CHECK ("audience" IN ('new_prospects', 'existing_customers', 'all'));
-- Personal lead queues follow ownership, not a campaign purpose; the system renewals list is for customers only.
UPDATE "dial_lists" SET "audience" = 'all' WHERE "is_dynamic" AND "filter_json" ? 'leadOwnerUserId';
UPDATE "dial_lists" SET "audience" = 'existing_customers' WHERE "filter_json"->>'system' = 'customers';

ALTER TABLE "leads" ADD COLUMN "existing_customer" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "leads" ADD COLUMN "review_reason" TEXT;
CREATE INDEX "leads_business_id_review_reason_idx" ON "leads" ("business_id") WHERE "review_reason" IS NOT NULL;
