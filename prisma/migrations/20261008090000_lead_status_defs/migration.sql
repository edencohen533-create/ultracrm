-- Lead statuses become rows with stable ids (additive; nothing removed).
--  • lead_status_defs: per business, the 7 system statuses (one per kind) + custom statuses with a kind (meaning).
--  • leads.status_def_id: set only for a custom status; leads.status keeps the meaning, so every existing rule works.
--  • calls.status_def_id: the CRM status chosen at wrap-up (apart from the telephony outcome).
CREATE TABLE "lead_status_defs" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "kind" "LeadStatus" NOT NULL,
    "label" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deleted_at" TIMESTAMP(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "lead_status_defs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "lead_status_defs_business_id_deleted_at_idx" ON "lead_status_defs"("business_id", "deleted_at");
-- Exactly one system status per kind per business.
CREATE UNIQUE INDEX "lead_status_defs_system_kind_key" ON "lead_status_defs"("business_id", "kind") WHERE "is_system";
ALTER TABLE "lead_status_defs" ADD CONSTRAINT "lead_status_defs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "leads" ADD COLUMN "status_def_id" TEXT;
ALTER TABLE "calls" ADD COLUMN "status_def_id" TEXT;
ALTER TABLE "leads" ADD CONSTRAINT "leads_status_def_id_fkey" FOREIGN KEY ("status_def_id") REFERENCES "lead_status_defs"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "calls" ADD CONSTRAINT "calls_status_def_id_fkey" FOREIGN KEY ("status_def_id") REFERENCES "lead_status_defs"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
CREATE INDEX "leads_status_def_id_idx" ON "leads"("status_def_id") WHERE "status_def_id" IS NOT NULL;

-- Backfill the system statuses from each business's saved labels / order; a status that was "hidden" stays
-- inactive (never silently offered again).
INSERT INTO "lead_status_defs" ("id", "business_id", "kind", "label", "sort_order", "is_system", "active", "created_at", "updated_at")
SELECT 'lsd' || md5(b."id" || ':' || k.kind), b."id", k.kind::"LeadStatus",
       COALESCE(NULLIF(btrim(x.item->>'label'), ''), k.label), COALESCE(x.ord::int - 1, 100 + k.ord),
       true, NOT COALESCE((x.item->>'hidden')::boolean, false), now(), now()
FROM "businesses" b
CROSS JOIN (VALUES ('new', 'חדש', 0), ('contacted', 'נוצר קשר', 1), ('follow_up', 'פולואפ', 2), ('qualified', 'מתאים', 3), ('unqualified', 'לא מתאים', 4), ('converted', 'הומר לעסקה', 5), ('lost', 'אבוד', 6)) AS k(kind, label, ord)
LEFT JOIN LATERAL (
  SELECT e.value AS item, e.ordinality AS ord
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b."settings"::jsonb -> 'leadStatuses') = 'array' THEN b."settings"::jsonb -> 'leadStatuses' ELSE '[]'::jsonb END) WITH ORDINALITY AS e(value, ordinality)
  WHERE e.value->>'key' = k.kind LIMIT 1
) x ON true
ON CONFLICT DO NOTHING;

-- Keep a lead's custom status and its meaning together: a status change made without choosing a custom status
-- (system rules: sale → converted, transfer → new …) falls back to the system status of the new meaning; a custom
-- status of another meaning is refused.
CREATE OR REPLACE FUNCTION lead_status_def_guard() RETURNS trigger AS $f$
DECLARE def_kind TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status_def_id IS NOT DISTINCT FROM OLD.status_def_id THEN
    NEW.status_def_id := NULL;
  END IF;
  IF NEW.status_def_id IS NOT NULL THEN
    SELECT kind::text INTO def_kind FROM lead_status_defs WHERE id = NEW.status_def_id AND business_id = NEW.business_id;
    IF def_kind IS NULL THEN RAISE EXCEPTION 'lead status % does not belong to this business', NEW.status_def_id; END IF;
    IF def_kind <> NEW.status::text THEN RAISE EXCEPTION 'lead status % has meaning %, not %', NEW.status_def_id, def_kind, NEW.status; END IF;
  END IF;
  RETURN NEW;
END $f$ LANGUAGE plpgsql;
CREATE TRIGGER leads_status_def_guard BEFORE INSERT OR UPDATE ON "leads" FOR EACH ROW EXECUTE FUNCTION lead_status_def_guard();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ultracrm_runtime') THEN
    ALTER TABLE "lead_status_defs" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "lead_status_defs" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON "lead_status_defs" TO ultracrm_runtime;
  END IF;
END $$;
