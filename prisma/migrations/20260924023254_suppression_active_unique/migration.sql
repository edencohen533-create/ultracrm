-- Only one ACTIVE suppression per (business, identifier, scope). Revoked rows keep history.
CREATE UNIQUE INDEX "suppressions_active_unique" ON "suppressions" ("business_id", "identifier", "scope") WHERE "revoked_at" IS NULL;
-- Fast lookup of the active suppressions for a set of identifiers.
CREATE INDEX "suppressions_active_lookup" ON "suppressions" ("business_id", "identifier") WHERE "revoked_at" IS NULL;
