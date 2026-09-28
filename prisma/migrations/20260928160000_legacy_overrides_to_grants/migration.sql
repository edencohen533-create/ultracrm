-- Legacy per-business module overrides no longer apply once a package version is pinned.
-- For pinned businesses, every module an override turned ON (and the version does not include) becomes an explicit
-- add-on grant – nobody loses access; the overrides are then cleared. (No production row matched when written.)
INSERT INTO "entitlement_grants" ("id", "business_id", "module", "kind", "seats", "starts_at", "note", "created_at")
  SELECT 'eg_' || b."id" || '_' || o.key, b."id", o.key, 'addon', NULL, now(), 'הומר מהתאמה ידנית קודמת', now()
  FROM "businesses" b JOIN "plan_versions" v ON v."id" = b."plan_version_id", jsonb_each(b."modules") o
  WHERE o.value = 'true'::jsonb AND COALESCE((v."modules"->o.key->>'included')::boolean, false) = false
  ON CONFLICT DO NOTHING;
UPDATE "businesses" SET "modules" = '{}'::jsonb WHERE "plan_version_id" IS NOT NULL AND "modules" <> '{}'::jsonb;
