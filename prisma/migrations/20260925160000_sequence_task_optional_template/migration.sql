ALTER TABLE "sequence_steps" ALTER COLUMN "template_id" DROP NOT NULL;
UPDATE "sequence_steps" SET "template_id" = NULL WHERE "action" = 'task';
