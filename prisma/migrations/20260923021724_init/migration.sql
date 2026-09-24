-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'manager', 'agent');

-- CreateEnum
CREATE TYPE "PresenceStatus" AS ENUM ('offline', 'available', 'in_call', 'wrap_up', 'paused');

-- CreateEnum
CREATE TYPE "DialMode" AS ENUM ('manual', 'preview', 'power');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('active', 'paused', 'ended');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('pending', 'locked', 'in_call', 'callback', 'completed', 'exhausted', 'removed', 'dnc');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('created', 'dialing_agent', 'agent_connected', 'dialing_lead', 'ringing', 'answered', 'ended', 'failed');

-- CreateEnum
CREATE TYPE "TelephonyResult" AS ENUM ('answered', 'no_answer', 'busy', 'failed', 'cancelled', 'rejected');

-- CreateEnum
CREATE TYPE "OutcomeKey" AS ENUM ('answered_interested', 'answered_not_interested', 'callback', 'no_answer', 'busy', 'wrong_number', 'sale', 'dnc');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('open', 'done', 'cancelled');

-- CreateEnum
CREATE TYPE "TelephonyProvider" AS ENUM ('mock', 'telnyx');

-- CreateEnum
CREATE TYPE "RecordingStatus" AS ENUM ('none', 'recording', 'saved', 'failed');

-- CreateTable
CREATE TABLE "businesses" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "manager_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'agent',
    "team_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "presence" "PresenceStatus" NOT NULL DEFAULT 'offline',
    "presence_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3),
    "telnyx_credential_id" TEXT,
    "sip_username" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "phone_raw" TEXT NOT NULL,
    "email" TEXT,
    "company" TEXT,
    "city" TEXT,
    "source" TEXT,
    "notes" TEXT,
    "custom_fields" JSONB,
    "owner_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dnc_entries" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "reason" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dnc_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dial_lists" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "filter_json" JSONB,
    "max_attempts" INTEGER,
    "retry_interval_minutes" INTEGER,
    "dial_window_json" JSONB,
    "script_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dial_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dial_list_agents" (
    "list_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dial_list_agents_pkey" PRIMARY KEY ("list_id","user_id")
);

-- CreateTable
CREATE TABLE "list_leads" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "list_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "status" "LeadStatus" NOT NULL DEFAULT 'pending',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3),
    "last_outcome" "OutcomeKey",
    "last_skip_reason" TEXT,
    "locked_by_user_id" TEXT,
    "lock_token" TEXT,
    "lock_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "list_leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dialer_sessions" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "list_id" TEXT,
    "mode" "DialMode" NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'active',
    "browser_session_id" TEXT NOT NULL,
    "countdown_seconds" INTEGER NOT NULL DEFAULT 5,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_heartbeat_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "dials_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "dialer_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calls" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "session_id" TEXT,
    "list_id" TEXT,
    "lead_id" TEXT,
    "contact_id" TEXT,
    "mode" "DialMode" NOT NULL,
    "provider" "TelephonyProvider" NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "active_for_user" TEXT,
    "to_e164" TEXT NOT NULL,
    "from_e164" TEXT NOT NULL,
    "phone_number_id" TEXT,
    "status" "CallStatus" NOT NULL DEFAULT 'created',
    "telephony_result" "TelephonyResult",
    "hangup_cause" TEXT,
    "hangup_source" TEXT,
    "amd_result" TEXT,
    "failure_reason" TEXT,
    "agent_leg_id" TEXT,
    "lead_leg_id" TEXT,
    "provider_session_id" TEXT,
    "dial_pending_since" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agent_answered_at" TIMESTAMP(3),
    "ringing_at" TIMESTAMP(3),
    "answered_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "talk_seconds" INTEGER,
    "outcome" "OutcomeKey",
    "outcome_note" TEXT,
    "outcome_saved_at" TIMESTAMP(3),
    "callback_at" TIMESTAMP(3),
    "recording_status" "RecordingStatus" NOT NULL DEFAULT 'none',
    "recording_id" TEXT,
    "recording_duration_ms" INTEGER,
    "recording_format" TEXT,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telephony_events" (
    "id" TEXT NOT NULL,
    "business_id" TEXT,
    "call_id" TEXT,
    "provider" "TelephonyProvider" NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "leg_id" TEXT,
    "occurred_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "payload" JSONB NOT NULL,

    CONSTRAINT "telephony_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "call_id" TEXT,
    "type" TEXT NOT NULL DEFAULT 'callback',
    "due_at" TIMESTAMP(3) NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'open',
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "done_at" TIMESTAMP(3),

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phone_numbers" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "e164" TEXT NOT NULL,
    "label" TEXT,
    "provider" "TelephonyProvider" NOT NULL DEFAULT 'telnyx',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phone_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scripts" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_drafts" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "note_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "actor_id" TEXT,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "businesses_slug_key" ON "businesses"("slug");

-- CreateIndex
CREATE INDEX "teams_business_id_idx" ON "teams"("business_id");

-- CreateIndex
CREATE INDEX "users_business_id_presence_idx" ON "users"("business_id", "presence");

-- CreateIndex
CREATE UNIQUE INDEX "users_business_id_email_key" ON "users"("business_id", "email");

-- CreateIndex
CREATE INDEX "contacts_business_id_full_name_idx" ON "contacts"("business_id", "full_name");

-- CreateIndex
CREATE INDEX "contacts_business_id_source_idx" ON "contacts"("business_id", "source");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_business_id_phone_e164_key" ON "contacts"("business_id", "phone_e164");

-- CreateIndex
CREATE UNIQUE INDEX "dnc_entries_business_id_phone_e164_key" ON "dnc_entries"("business_id", "phone_e164");

-- CreateIndex
CREATE INDEX "dial_lists_business_id_is_active_idx" ON "dial_lists"("business_id", "is_active");

-- CreateIndex
CREATE INDEX "list_leads_list_id_status_priority_next_attempt_at_idx" ON "list_leads"("list_id", "status", "priority", "next_attempt_at");

-- CreateIndex
CREATE INDEX "list_leads_locked_by_user_id_idx" ON "list_leads"("locked_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "list_leads_list_id_contact_id_key" ON "list_leads"("list_id", "contact_id");

-- CreateIndex
CREATE INDEX "dialer_sessions_user_id_status_idx" ON "dialer_sessions"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "calls_idempotency_key_key" ON "calls"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "calls_active_for_user_key" ON "calls"("active_for_user");

-- CreateIndex
CREATE INDEX "calls_business_id_created_at_idx" ON "calls"("business_id", "created_at");

-- CreateIndex
CREATE INDEX "calls_user_id_created_at_idx" ON "calls"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "calls_contact_id_created_at_idx" ON "calls"("contact_id", "created_at");

-- CreateIndex
CREATE INDEX "calls_agent_leg_id_idx" ON "calls"("agent_leg_id");

-- CreateIndex
CREATE INDEX "calls_lead_leg_id_idx" ON "calls"("lead_leg_id");

-- CreateIndex
CREATE INDEX "telephony_events_call_id_idx" ON "telephony_events"("call_id");

-- CreateIndex
CREATE UNIQUE INDEX "telephony_events_provider_provider_event_id_key" ON "telephony_events"("provider", "provider_event_id");

-- CreateIndex
CREATE INDEX "tasks_user_id_status_due_at_idx" ON "tasks"("user_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "tasks_business_id_status_due_at_idx" ON "tasks"("business_id", "status", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "phone_numbers_business_id_e164_key" ON "phone_numbers"("business_id", "e164");

-- CreateIndex
CREATE UNIQUE INDEX "note_drafts_user_id_contact_id_key" ON "note_drafts"("user_id", "contact_id");

-- CreateIndex
CREATE INDEX "audit_logs_business_id_entity_type_entity_id_idx" ON "audit_logs"("business_id", "entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dnc_entries" ADD CONSTRAINT "dnc_entries_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dnc_entries" ADD CONSTRAINT "dnc_entries_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dial_lists" ADD CONSTRAINT "dial_lists_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dial_lists" ADD CONSTRAINT "dial_lists_script_id_fkey" FOREIGN KEY ("script_id") REFERENCES "scripts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dial_list_agents" ADD CONSTRAINT "dial_list_agents_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "dial_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dial_list_agents" ADD CONSTRAINT "dial_list_agents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "list_leads" ADD CONSTRAINT "list_leads_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "list_leads" ADD CONSTRAINT "list_leads_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "dial_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "list_leads" ADD CONSTRAINT "list_leads_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "list_leads" ADD CONSTRAINT "list_leads_locked_by_user_id_fkey" FOREIGN KEY ("locked_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dialer_sessions" ADD CONSTRAINT "dialer_sessions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dialer_sessions" ADD CONSTRAINT "dialer_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dialer_sessions" ADD CONSTRAINT "dialer_sessions_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "dial_lists"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "dialer_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "dial_lists"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "list_leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "phone_numbers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telephony_events" ADD CONSTRAINT "telephony_events_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telephony_events" ADD CONSTRAINT "telephony_events_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "list_leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_drafts" ADD CONSTRAINT "note_drafts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_drafts" ADD CONSTRAINT "note_drafts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_drafts" ADD CONSTRAINT "note_drafts_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
