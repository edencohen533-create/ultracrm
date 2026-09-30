-- Journeys: draft / active / paused, unpublished edits, published versions pinned by runs. Additive; existing
-- journeys keep exactly their state (active stays active, inactive becomes "paused").
ALTER TABLE "marketing_sequences" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "marketing_sequences" ADD COLUMN "draft" JSONB;
ALTER TABLE "marketing_sequences" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "marketing_sequences" ADD COLUMN "published_at" TIMESTAMP(3);
UPDATE "marketing_sequences" SET "status" = CASE WHEN "is_active" THEN 'active' ELSE 'paused' END;
ALTER TABLE "sequence_runs" ADD COLUMN "version_id" TEXT;

CREATE TABLE "sequence_versions" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "sequence_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "checks" JSONB NOT NULL DEFAULT '[]',
    "published_by_id" TEXT,
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sequence_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sequence_versions_sequence_id_version_key" ON "sequence_versions"("sequence_id", "version");
CREATE INDEX "sequence_versions_business_id_sequence_id_idx" ON "sequence_versions"("business_id", "sequence_id");
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ultracrm_runtime') THEN
    ALTER TABLE "sequence_versions" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "sequence_versions" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "sequence_versions" TO ultracrm_runtime;
  END IF;
END $$;
