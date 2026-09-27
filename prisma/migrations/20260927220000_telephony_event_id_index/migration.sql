-- Under RLS the (provider, provider_event_id) unique index is skipped (enum equality is not leakproof), so every
-- telephony event lookup was a sequential scan that grew with the table. Text equality is leakproof → usable here.
CREATE INDEX "telephony_events_provider_event_id_idx" ON "telephony_events"("provider_event_id");
