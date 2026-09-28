-- A lost lead transferred to another agent restarts as "new"; attempts count from reopened_at.
ALTER TABLE "leads" ADD COLUMN "reopened_at" TIMESTAMP(3);
