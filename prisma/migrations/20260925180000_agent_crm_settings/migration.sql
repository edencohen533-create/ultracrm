ALTER TABLE "users" ADD COLUMN "crm_settings" JSONB;
ALTER TABLE "list_leads" ADD COLUMN "follow_up_attempts" INTEGER;
-- Preserve existing scheduled follow-ups as the start of a follow-up cycle.
UPDATE "list_leads" SET "follow_up_attempts" = 0 WHERE "status" = 'callback';
