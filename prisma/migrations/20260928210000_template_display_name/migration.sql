-- Editable name shown in the app; the provider (Meta) name stays fixed and is used for sending.
ALTER TABLE "templates" ADD COLUMN "display_name" TEXT;
