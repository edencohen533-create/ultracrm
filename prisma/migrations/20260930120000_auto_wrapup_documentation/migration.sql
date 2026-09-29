-- Automatic wrap-up (no blocking manual documentation) + a real status for the AI call documentation. Additive only.
ALTER TYPE "OutcomeKey" ADD VALUE IF NOT EXISTS 'answered';
ALTER TABLE "coach_sessions" ADD COLUMN "documentation_status" TEXT;
ALTER TABLE "coach_sessions" ADD COLUMN "documentation_error" TEXT;
ALTER TABLE "coach_sessions" ADD COLUMN "documentation_attempts" INTEGER NOT NULL DEFAULT 0;
-- Existing documented sessions are "done".
UPDATE "coach_sessions" SET "documentation_status" = 'done' WHERE "documented_at" IS NOT NULL;
