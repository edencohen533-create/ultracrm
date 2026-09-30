-- AlterTable
ALTER TABLE "calls" ADD COLUMN     "recording_purged_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "knowledge_sources" ADD COLUMN     "sales_shared" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "sales_recordings" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "call_id" TEXT,
    "deal_id" TEXT,
    "title" TEXT NOT NULL,
    "file_name" TEXT,
    "mime_type" TEXT,
    "size_bytes" INTEGER,
    "duration_sec" INTEGER,
    "sha256" TEXT,
    "status" TEXT NOT NULL DEFAULT 'uploading',
    "error" TEXT,
    "segments" JSONB NOT NULL DEFAULT '[]',
    "transcript" TEXT NOT NULL DEFAULT '',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),
    "auto" BOOLEAN NOT NULL DEFAULT false,
    "cost_usd" DECIMAL(10,5) NOT NULL DEFAULT 0,
    "created_by_id" TEXT,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_recordings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_recording_chunks" (
    "recording_id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,

    CONSTRAINT "sales_recording_chunks_pkey" PRIMARY KEY ("recording_id","idx")
);

-- CreateTable
CREATE TABLE "sales_insights" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "recording_id" TEXT,
    "deal_id" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "objection" TEXT,
    "quote" TEXT NOT NULL DEFAULT '',
    "start_ms" INTEGER,
    "end_ms" INTEGER,
    "flags" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'candidate',
    "version" INTEGER NOT NULL DEFAULT 1,
    "parent_id" TEXT,
    "root_id" TEXT,
    "auto_published" BOOLEAN NOT NULL DEFAULT false,
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "review_reason" TEXT,
    "embedding" JSONB,
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_insights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_deal_learnings" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "deal_id" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "call_ids" JSONB NOT NULL DEFAULT '[]',
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_deal_learnings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_recordings_business_id_status_idx" ON "sales_recordings"("business_id", "status");

-- CreateIndex
CREATE INDEX "sales_recordings_business_id_deal_id_idx" ON "sales_recordings"("business_id", "deal_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_recordings_business_id_call_id_key" ON "sales_recordings"("business_id", "call_id");

-- CreateIndex
CREATE INDEX "sales_recording_chunks_business_id_idx" ON "sales_recording_chunks"("business_id");

-- CreateIndex
CREATE INDEX "sales_insights_business_id_status_idx" ON "sales_insights"("business_id", "status");

-- CreateIndex
CREATE INDEX "sales_insights_business_id_deal_id_idx" ON "sales_insights"("business_id", "deal_id");

-- CreateIndex
CREATE INDEX "sales_insights_recording_id_idx" ON "sales_insights"("recording_id");

-- CreateIndex
CREATE INDEX "sales_insights_root_id_idx" ON "sales_insights"("root_id");

-- CreateIndex
CREATE INDEX "sales_deal_learnings_business_id_status_idx" ON "sales_deal_learnings"("business_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sales_deal_learnings_deal_id_key" ON "sales_deal_learnings"("deal_id");

-- AddForeignKey
ALTER TABLE "sales_recordings" ADD CONSTRAINT "sales_recordings_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_recording_chunks" ADD CONSTRAINT "sales_recording_chunks_recording_id_fkey" FOREIGN KEY ("recording_id") REFERENCES "sales_recordings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_insights" ADD CONSTRAINT "sales_insights_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_insights" ADD CONSTRAINT "sales_insights_recording_id_fkey" FOREIGN KEY ("recording_id") REFERENCES "sales_recordings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_deal_learnings" ADD CONSTRAINT "sales_deal_learnings_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The same uploaded file is processed once per business (deleted rows don't block a re-upload).
CREATE UNIQUE INDEX "sales_recordings_business_sha_live_key" ON "sales_recordings"("business_id", "sha256") WHERE "sha256" IS NOT NULL AND "status" <> 'deleted';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ultracrm_runtime') THEN
    ALTER TABLE "sales_recordings" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "sales_recordings" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "sales_recordings" TO ultracrm_runtime;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ultracrm_runtime') THEN
    ALTER TABLE "sales_recording_chunks" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "sales_recording_chunks" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "sales_recording_chunks" TO ultracrm_runtime;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ultracrm_runtime') THEN
    ALTER TABLE "sales_insights" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "sales_insights" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "sales_insights" TO ultracrm_runtime;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ultracrm_runtime') THEN
    ALTER TABLE "sales_deal_learnings" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "sales_deal_learnings" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "sales_deal_learnings" TO ultracrm_runtime;
  END IF;
END $$;


-- "ללמוד גם מהקלטות שמורות" also fed call documentation; that part keeps its current value under its own key.
UPDATE "businesses" SET "settings" = jsonb_set("settings"::jsonb, '{coach,documentFromRecordings}', to_jsonb(COALESCE(("settings"::jsonb #>> '{coach,learnFromRecordings}')::boolean, false)))
WHERE "settings"::jsonb ? 'coach' AND jsonb_typeof("settings"::jsonb -> 'coach') = 'object';
