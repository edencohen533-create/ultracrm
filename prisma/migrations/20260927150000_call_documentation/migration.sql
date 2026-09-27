-- AI documentation of a call (summary + timeline of the whole conversation).
ALTER TABLE "coach_sessions" ADD COLUMN "documentation" JSONB,
ADD COLUMN "documented_at" TIMESTAMP(3);
