-- Sending pace per campaign ({ batchSize, intervalMinutes }).
ALTER TABLE "campaigns" ADD COLUMN "throttle" JSONB;
