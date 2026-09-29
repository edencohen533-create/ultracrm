-- Uploaded template header images (per business) and their Meta media ids per WhatsApp number. Additive only.
CREATE TABLE "media_assets" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'template_header',
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "data" BYTEA NOT NULL DEFAULT '\x',
    "sha256" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'uploading',
    "created_by_id" TEXT,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "media_assets_business_id_kind_status_idx" ON "media_assets"("business_id", "kind", "status");
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "media_provider_uploads" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "provider_media_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "media_provider_uploads_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "media_provider_uploads_asset_id_credential_id_key" ON "media_provider_uploads"("asset_id", "credential_id");
ALTER TABLE "media_provider_uploads" ADD CONSTRAINT "media_provider_uploads_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "media_provider_uploads" ADD CONSTRAINT "media_provider_uploads_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "templates" ADD COLUMN "header_media_asset_id" TEXT;
ALTER TABLE "templates" ADD CONSTRAINT "templates_header_media_asset_id_fkey" FOREIGN KEY ("header_media_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "media_assets" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "media_assets" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON "media_assets" TO ultracrm_runtime;
ALTER TABLE "media_provider_uploads" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "media_provider_uploads" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON "media_provider_uploads" TO ultracrm_runtime;
