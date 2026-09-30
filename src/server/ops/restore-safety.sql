-- Restore safety: run on a database restored from backup BEFORE anything can read its queues.
-- Work that was in flight at backup time is stopped / parked, so the restored copy can never repeat an action
-- (dial, send, charge, sync) that may already have happened in the real system.
UPDATE list_leads SET status = 'pending', locked_by_user_id = NULL, lock_expires_at = NULL WHERE status IN ('locked', 'in_call');
UPDATE calls SET ended_at = now(), active_for_user = NULL, failure_reason = COALESCE(failure_reason, 'restored-from-backup') WHERE ended_at IS NULL;
UPDATE domain_events SET status = 'failed', last_error = 'parked: restored from backup' WHERE status IN ('pending', 'processing');
UPDATE webhook_deliveries SET status = 'failed', error = 'parked: restored from backup' WHERE status = 'pending';
UPDATE crm_outbox SET status = 'cancelled', last_error = 'parked: restored from backup' WHERE status IN ('pending', 'failed');
UPDATE campaigns SET status = 'PAUSED' WHERE status IN ('SCHEDULED', 'RUNNING');
UPDATE sequence_runs SET status = 'STOPPED' WHERE status IN ('PENDING', 'RUNNING');
UPDATE budget_reservations SET status = 'released' WHERE status = 'held';
UPDATE dialer_sessions SET status = 'ended', ended_at = now() WHERE status IN ('active', 'paused');
