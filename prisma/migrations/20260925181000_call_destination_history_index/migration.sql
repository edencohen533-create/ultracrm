-- Supports per-contact retry caps and caller-ID history without a scan per queue candidate.
CREATE INDEX CONCURRENTLY "calls_business_id_to_e164_created_at_idx" ON "calls" ("business_id", "to_e164", "created_at");
