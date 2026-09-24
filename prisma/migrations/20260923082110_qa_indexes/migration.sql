-- CreateIndex
CREATE INDEX "calls_lead_id_idx" ON "calls"("lead_id");

-- CreateIndex
CREATE INDEX "calls_user_id_ended_at_outcome_saved_at_idx" ON "calls"("user_id", "ended_at", "outcome_saved_at");

-- CreateIndex
CREATE INDEX "tasks_contact_id_status_idx" ON "tasks"("contact_id", "status");

-- CreateIndex
CREATE INDEX "tasks_call_id_idx" ON "tasks"("call_id");
