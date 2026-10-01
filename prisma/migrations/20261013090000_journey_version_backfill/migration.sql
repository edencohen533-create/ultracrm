-- Journeys saved before versioning have version >= 1 but no sequence_versions row, so their runs were not pinned and
-- followed the live steps. Record the current steps as that version and pin runs still in progress to it.
INSERT INTO "sequence_versions" ("id", "business_id", "sequence_id", "version", "definition", "checks", "published_by_id", "published_at")
SELECT 'sv' || md5(s."id" || ':' || s."version"), s."business_id", s."id", s."version",
  jsonb_build_object(
    'name', s."name", 'trigger', s."trigger", 'triggerConfig', COALESCE(s."trigger_config", '{}'::jsonb), 'stopOn', to_jsonb(s."stop_on"),
    'steps', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'sequenceId', st."sequence_id", 'position', st."position", 'action', st."action", 'channel', st."channel", 'templateId', st."template_id",
      'waitMinutes', st."wait_minutes", 'variables', COALESCE(st."variables", '{}'::jsonb), 'condition', COALESCE(st."condition", '{}'::jsonb)) ORDER BY st."position")
      FROM "sequence_steps" st WHERE st."sequence_id" = s."id"), '[]'::jsonb)),
  '[]'::jsonb, NULL, COALESCE(s."published_at", s."updated_at")
FROM "marketing_sequences" s
WHERE s."version" >= 1 AND NOT EXISTS (SELECT 1 FROM "sequence_versions" v WHERE v."sequence_id" = s."id" AND v."version" = s."version");

UPDATE "sequence_runs" r SET "version_id" = v."id"
FROM "marketing_sequences" s JOIN "sequence_versions" v ON v."sequence_id" = s."id" AND v."version" = s."version"
WHERE r."sequence_id" = s."id" AND r."version_id" IS NULL AND r."status" IN ('PENDING', 'RUNNING');
