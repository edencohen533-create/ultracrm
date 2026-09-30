-- Dial-list priority moves to a 1–10 scale (10 = highest). Additive, no data removed:
-- the old default 0 becomes the new default 5; values above 10 are capped at 10; 1–10 stay as they are.
ALTER TABLE "dial_lists" ALTER COLUMN "priority" SET DEFAULT 5;
UPDATE "dial_lists" SET "priority" = CASE WHEN "priority" <= 0 THEN 5 ELSE 10 END WHERE "priority" < 1 OR "priority" > 10;
