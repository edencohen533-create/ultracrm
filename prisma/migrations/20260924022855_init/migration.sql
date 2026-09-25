-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('owner', 'manager', 'agent');

-- CreateEnum
CREATE TYPE "PresenceStatus" AS ENUM ('offline', 'available', 'in_call', 'wrap_up', 'paused');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('open', 'done', 'cancelled');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('callback', 'follow_up', 'todo');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('new', 'contacted', 'qualified', 'unqualified', 'converted', 'lost');

-- CreateEnum
CREATE TYPE "DealStage" AS ENUM ('new', 'proposal', 'negotiation', 'won', 'lost');

-- CreateEnum
CREATE TYPE "DealStatus" AS ENUM ('open', 'won', 'lost');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('whatsapp', 'sms', 'email');

-- CreateEnum
CREATE TYPE "MessageCategory" AS ENUM ('service', 'marketing');

-- CreateEnum
CREATE TYPE "SuppressionScope" AS ENUM ('marketing', 'all');

-- CreateEnum
CREATE TYPE "IdentifierType" AS ENUM ('phone', 'email');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('pending', 'processing', 'done', 'failed');

-- CreateEnum
CREATE TYPE "DialMode" AS ENUM ('manual', 'preview', 'power');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('active', 'paused', 'ended');

-- CreateEnum
CREATE TYPE "QueueLeadStatus" AS ENUM ('pending', 'locked', 'in_call', 'callback', 'completed', 'exhausted', 'removed', 'dnc');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('created', 'dialing_agent', 'agent_connected', 'dialing_lead', 'ringing', 'answered', 'ended', 'failed');

-- CreateEnum
CREATE TYPE "TelephonyResult" AS ENUM ('answered', 'no_answer', 'busy', 'failed', 'cancelled', 'rejected');

-- CreateEnum
CREATE TYPE "OutcomeKey" AS ENUM ('answered_interested', 'answered_not_interested', 'callback', 'no_answer', 'busy', 'wrong_number', 'sale', 'dnc');

-- CreateEnum
CREATE TYPE "TelephonyProvider" AS ENUM ('mock', 'telnyx');

-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('outbound', 'inbound');

-- CreateEnum
CREATE TYPE "MonitorMode" AS ENUM ('listen', 'whisper');

-- CreateEnum
CREATE TYPE "MonitorStatus" AS ENUM ('connecting', 'listening', 'whispering', 'ended', 'failed');

-- CreateEnum
CREATE TYPE "RecordingStatus" AS ENUM ('none', 'recording', 'saved', 'failed');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'PENDING', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ConversationSource" AS ENUM ('WHATSAPP', 'MOCK', 'MANUAL');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'LINK', 'TEMPLATE');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('ACCEPTED', 'UNKNOWN', 'QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('UNKNOWN', 'OPTED_IN', 'OPTED_OUT');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TemplateCategory" AS ENUM ('MARKETING', 'UTILITY', 'AUTHENTICATION');

-- CreateEnum
CREATE TYPE "AutomationTrigger" AS ENUM ('NEW_INBOUND_MESSAGE', 'NEW_CONVERSATION', 'TAG_ADDED', 'CONVERSATION_UNASSIGNED', 'NO_REPLY_TIMEOUT');

-- CreateEnum
CREATE TYPE "AutomationActionType" AS ENUM ('ASSIGN_AGENT', 'ADD_TAG', 'CHANGE_STATUS', 'ADD_INTERNAL_NOTE', 'SEND_CANNED_REPLY', 'SEND_TEMPLATE');

-- CreateEnum
CREATE TYPE "AutomationRunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RecipientStatus" AS ENUM ('QUEUED', 'PROCESSING', 'SENT', 'FAILED', 'SKIPPED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "modules" JSONB NOT NULL DEFAULT '{}',
    "quotas" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "businesses" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "plan_id" TEXT,
    "modules" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "last_campaign_scan_at" TIMESTAMP(3),
    "last_automation_scan_at" TIMESTAMP(3),
    "last_event_scan_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'agent',
    "team_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "avatar_url" TEXT,
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
CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "manager_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_counters" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_counters_pkey" PRIMARY KEY ("id")
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
    "consent_status" "ConsentStatus" NOT NULL DEFAULT 'UNKNOWN',
    "consent_at" TIMESTAMP(3),
    "consent_source" TEXT,
    "consent_evidence" TEXT,
    "consent_scope" TEXT,
    "last_marketing_at" TIMESTAMP(3),
    "is_blocked" BOOLEAN NOT NULL DEFAULT false,
    "last_activity_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_phones" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "e164" TEXT NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_phones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_emails" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6366f1',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_tags" (
    "contact_id" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,

    CONSTRAINT "contact_tags_pkey" PRIMARY KEY ("contact_id","tag_id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "title" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'new',
    "source" TEXT,
    "owner_user_id" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "deal_id" TEXT,
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deals" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "title" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "stage" "DealStage" NOT NULL DEFAULT 'new',
    "status" "DealStatus" NOT NULL DEFAULT 'open',
    "owner_user_id" TEXT,
    "expected_close_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_by_id" TEXT,
    "contact_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "deal_id" TEXT,
    "list_lead_id" TEXT,
    "call_id" TEXT,
    "conversation_id" TEXT,
    "type" "TaskType" NOT NULL DEFAULT 'callback',
    "title" TEXT,
    "due_at" TIMESTAMP(3) NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'open',
    "note" TEXT,
    "request_key" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "done_at" TIMESTAMP(3),

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notes" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "contact_id" TEXT,
    "conversation_id" TEXT,
    "deal_id" TEXT,
    "author_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "mentioned_user_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppressions" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "contact_id" TEXT,
    "identifier_type" "IdentifierType" NOT NULL,
    "identifier" TEXT NOT NULL,
    "scope" "SuppressionScope" NOT NULL DEFAULT 'marketing',
    "source" TEXT NOT NULL,
    "reason" TEXT,
    "evidence" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "revoked_by_user_id" TEXT,
    "revoke_evidence" TEXT,

    CONSTRAINT "suppressions_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "domain_events" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "contact_id" TEXT,
    "actor_user_id" TEXT,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'system',
    "depth" INTEGER NOT NULL DEFAULT 0,
    "dedupe_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "EventStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "locked_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),
    "last_error" TEXT,

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_jobs" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "handler" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'done',
    "result" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "automation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "actor_id" TEXT,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "conversation_id" TEXT,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
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
    "phone_number_id" TEXT,
    "is_dynamic" BOOLEAN NOT NULL DEFAULT false,
    "is_paused" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMP(3),
    "last_refreshed_at" TIMESTAMP(3),
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
    "status" "QueueLeadStatus" NOT NULL DEFAULT 'pending',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3),
    "last_outcome" "OutcomeKey",
    "last_skip_reason" TEXT,
    "preferred_user_id" TEXT,
    "claim_reason" TEXT,
    "claim_score" DOUBLE PRECISION,
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
    "direction" "CallDirection" NOT NULL DEFAULT 'outbound',
    "provider" "TelephonyProvider" NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "routing_note" TEXT,
    "conference_id" TEXT,
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
    "lead_dialed_at" TIMESTAMP(3),
    "hangup_requested_at" TIMESTAMP(3),
    "last_event_at" TIMESTAMP(3),
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
CREATE TABLE "call_monitors" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "call_id" TEXT NOT NULL,
    "manager_id" TEXT NOT NULL,
    "active_for_manager" TEXT,
    "mode" "MonitorMode" NOT NULL DEFAULT 'listen',
    "status" "MonitorStatus" NOT NULL DEFAULT 'connecting',
    "leg_id" TEXT,
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joined_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "last_event_at" TIMESTAMP(3),

    CONSTRAINT "call_monitors_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "provider_credentials" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "channel" "Channel" NOT NULL DEFAULT 'whatsapp',
    "provider" TEXT NOT NULL,
    "label" TEXT,
    "display_phone_number" TEXT,
    "phone_number_id" TEXT,
    "team_id" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "sending_blocked" BOOLEAN NOT NULL DEFAULT false,
    "last_checked_at" TIMESTAMP(3),
    "last_webhook_at" TIMESTAMP(3),
    "last_connection_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "channel" "Channel" NOT NULL DEFAULT 'whatsapp',
    "contact_id" TEXT NOT NULL,
    "provider_credential_id" TEXT,
    "assigned_agent_id" TEXT,
    "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
    "source" "ConversationSource" NOT NULL DEFAULT 'MOCK',
    "is_spam" BOOLEAN NOT NULL DEFAULT false,
    "last_message_at" TIMESTAMP(3),
    "last_inbound_at" TIMESTAMP(3),
    "unread_count" INTEGER NOT NULL DEFAULT 0,
    "send_lock_token" TEXT,
    "send_lock_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "channel" "Channel" NOT NULL DEFAULT 'whatsapp',
    "category" "MessageCategory" NOT NULL DEFAULT 'service',
    "direction" "MessageDirection" NOT NULL,
    "type" "MessageType" NOT NULL,
    "body" TEXT,
    "status" "MessageStatus" NOT NULL DEFAULT 'SENT',
    "sent_by_user_id" TEXT,
    "template_id" TEXT,
    "provider_credential_id" TEXT,
    "provider_message_id" TEXT,
    "inbound_key" TEXT,
    "request_key" TEXT,
    "error_reason" TEXT,
    "accepted_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_attachments" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "provider_media_id" TEXT,
    "mime_type" TEXT NOT NULL,
    "file_name" TEXT,
    "size_bytes" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_tags" (
    "conversation_id" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,

    CONSTRAINT "conversation_tags_pkey" PRIMARY KEY ("conversation_id","tag_id")
);

-- CreateTable
CREATE TABLE "conversation_drafts" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canned_replies" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "shortcut" TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "canned_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "templates" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "channel" "Channel" NOT NULL DEFAULT 'whatsapp',
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'he',
    "category" "TemplateCategory" NOT NULL DEFAULT 'UTILITY',
    "provider_template_id" TEXT,
    "provider_account_id" TEXT,
    "sync_error" TEXT,
    "body" TEXT NOT NULL,
    "variables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "TemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "trigger" "AutomationTrigger" NOT NULL,
    "trigger_config" JSONB NOT NULL DEFAULT '{}',
    "action_type" "AutomationActionType" NOT NULL,
    "action_config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "conversation_id" TEXT,
    "status" "AutomationRunStatus" NOT NULL DEFAULT 'PENDING',
    "scheduled_for" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trigger_payload" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "distribution_lists" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "segment" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "distribution_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "distribution_list_members" (
    "list_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,

    CONSTRAINT "distribution_list_members_pkey" PRIMARY KEY ("list_id","contact_id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "channel" "Channel" NOT NULL DEFAULT 'whatsapp',
    "name" TEXT NOT NULL,
    "list_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "provider_credential_id" TEXT,
    "variables" JSONB NOT NULL DEFAULT '{}',
    "excluded_list_ids" JSONB NOT NULL DEFAULT '[]',
    "audience_snapshot" JSONB,
    "audience_excluded_count" INTEGER NOT NULL DEFAULT 0,
    "sender_snapshot" TEXT,
    "template_snapshot" TEXT,
    "created_by_id" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_recipients" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "status" "RecipientStatus" NOT NULL DEFAULT 'QUEUED',
    "message_id" TEXT,
    "error" TEXT,
    "claimed_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "campaign_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_key_key" ON "plans"("key");

-- CreateIndex
CREATE UNIQUE INDEX "businesses_slug_key" ON "businesses"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_email_key" ON "accounts"("email");

-- CreateIndex
CREATE INDEX "users_account_id_idx" ON "users"("account_id");

-- CreateIndex
CREATE INDEX "users_business_id_presence_idx" ON "users"("business_id", "presence");

-- CreateIndex
CREATE UNIQUE INDEX "users_business_id_account_id_key" ON "users"("business_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_business_id_email_key" ON "users"("business_id", "email");

-- CreateIndex
CREATE INDEX "teams_business_id_idx" ON "teams"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "usage_counters_business_id_metric_period_key" ON "usage_counters"("business_id", "metric", "period");

-- CreateIndex
CREATE INDEX "contacts_business_id_full_name_idx" ON "contacts"("business_id", "full_name");

-- CreateIndex
CREATE INDEX "contacts_business_id_email_idx" ON "contacts"("business_id", "email");

-- CreateIndex
CREATE INDEX "contacts_business_id_source_idx" ON "contacts"("business_id", "source");

-- CreateIndex
CREATE INDEX "contacts_business_id_owner_user_id_idx" ON "contacts"("business_id", "owner_user_id");

-- CreateIndex
CREATE INDEX "contacts_business_id_last_activity_at_idx" ON "contacts"("business_id", "last_activity_at");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_business_id_phone_e164_key" ON "contacts"("business_id", "phone_e164");

-- CreateIndex
CREATE INDEX "contact_phones_contact_id_idx" ON "contact_phones"("contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_phones_business_id_e164_key" ON "contact_phones"("business_id", "e164");

-- CreateIndex
CREATE INDEX "contact_emails_contact_id_idx" ON "contact_emails"("contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_emails_business_id_email_key" ON "contact_emails"("business_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "tags_business_id_name_key" ON "tags"("business_id", "name");

-- CreateIndex
CREATE INDEX "leads_business_id_status_created_at_idx" ON "leads"("business_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "leads_business_id_owner_user_id_status_idx" ON "leads"("business_id", "owner_user_id", "status");

-- CreateIndex
CREATE INDEX "leads_contact_id_idx" ON "leads"("contact_id");

-- CreateIndex
CREATE INDEX "deals_business_id_status_stage_idx" ON "deals"("business_id", "status", "stage");

-- CreateIndex
CREATE INDEX "deals_business_id_owner_user_id_idx" ON "deals"("business_id", "owner_user_id");

-- CreateIndex
CREATE INDEX "deals_contact_id_idx" ON "deals"("contact_id");

-- CreateIndex
CREATE INDEX "tasks_user_id_status_due_at_idx" ON "tasks"("user_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "tasks_business_id_status_due_at_idx" ON "tasks"("business_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "tasks_contact_id_status_idx" ON "tasks"("contact_id", "status");

-- CreateIndex
CREATE INDEX "tasks_call_id_idx" ON "tasks"("call_id");

-- CreateIndex
CREATE INDEX "tasks_list_lead_id_idx" ON "tasks"("list_lead_id");

-- CreateIndex
CREATE INDEX "tasks_conversation_id_idx" ON "tasks"("conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_business_id_request_key_key" ON "tasks"("business_id", "request_key");

-- CreateIndex
CREATE INDEX "notes_business_id_contact_id_created_at_idx" ON "notes"("business_id", "contact_id", "created_at");

-- CreateIndex
CREATE INDEX "notes_conversation_id_idx" ON "notes"("conversation_id");

-- CreateIndex
CREATE INDEX "suppressions_business_id_identifier_revoked_at_idx" ON "suppressions"("business_id", "identifier", "revoked_at");

-- CreateIndex
CREATE INDEX "suppressions_business_id_contact_id_idx" ON "suppressions"("business_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "dnc_entries_business_id_phone_e164_key" ON "dnc_entries"("business_id", "phone_e164");

-- CreateIndex
CREATE INDEX "domain_events_status_next_attempt_at_idx" ON "domain_events"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "domain_events_business_id_contact_id_occurred_at_idx" ON "domain_events"("business_id", "contact_id", "occurred_at");

-- CreateIndex
CREATE INDEX "domain_events_business_id_type_occurred_at_idx" ON "domain_events"("business_id", "type", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "domain_events_business_id_dedupe_key_key" ON "domain_events"("business_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "automation_jobs_business_id_created_at_idx" ON "automation_jobs"("business_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "automation_jobs_event_id_handler_key" ON "automation_jobs"("event_id", "handler");

-- CreateIndex
CREATE INDEX "audit_logs_business_id_entity_type_entity_id_idx" ON "audit_logs"("business_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_business_id_created_at_idx" ON "audit_logs"("business_id", "created_at");

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
CREATE INDEX "calls_lead_id_idx" ON "calls"("lead_id");

-- CreateIndex
CREATE INDEX "calls_user_id_ended_at_outcome_saved_at_idx" ON "calls"("user_id", "ended_at", "outcome_saved_at");

-- CreateIndex
CREATE INDEX "calls_agent_leg_id_idx" ON "calls"("agent_leg_id");

-- CreateIndex
CREATE INDEX "calls_lead_leg_id_idx" ON "calls"("lead_leg_id");

-- CreateIndex
CREATE UNIQUE INDEX "call_monitors_active_for_manager_key" ON "call_monitors"("active_for_manager");

-- CreateIndex
CREATE INDEX "call_monitors_call_id_status_idx" ON "call_monitors"("call_id", "status");

-- CreateIndex
CREATE INDEX "call_monitors_leg_id_idx" ON "call_monitors"("leg_id");

-- CreateIndex
CREATE INDEX "telephony_events_call_id_idx" ON "telephony_events"("call_id");

-- CreateIndex
CREATE UNIQUE INDEX "telephony_events_provider_provider_event_id_key" ON "telephony_events"("provider", "provider_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "phone_numbers_business_id_e164_key" ON "phone_numbers"("business_id", "e164");

-- CreateIndex
CREATE UNIQUE INDEX "note_drafts_user_id_contact_id_key" ON "note_drafts"("user_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_credentials_phone_number_id_key" ON "provider_credentials"("phone_number_id");

-- CreateIndex
CREATE INDEX "provider_credentials_business_id_is_active_idx" ON "provider_credentials"("business_id", "is_active");

-- CreateIndex
CREATE INDEX "conversations_business_id_status_last_message_at_idx" ON "conversations"("business_id", "status", "last_message_at");

-- CreateIndex
CREATE INDEX "conversations_business_id_assigned_agent_id_idx" ON "conversations"("business_id", "assigned_agent_id");

-- CreateIndex
CREATE INDEX "conversations_contact_id_idx" ON "conversations"("contact_id");

-- CreateIndex
CREATE INDEX "conversations_provider_credential_id_idx" ON "conversations"("provider_credential_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_inbound_key_key" ON "messages"("inbound_key");

-- CreateIndex
CREATE UNIQUE INDEX "messages_request_key_key" ON "messages"("request_key");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_business_id_provider_message_id_idx" ON "messages"("business_id", "provider_message_id");

-- CreateIndex
CREATE INDEX "messages_business_id_created_at_idx" ON "messages"("business_id", "created_at");

-- CreateIndex
CREATE INDEX "message_attachments_message_id_idx" ON "message_attachments"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_drafts_conversation_id_user_id_key" ON "conversation_drafts"("conversation_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "canned_replies_business_id_shortcut_key" ON "canned_replies"("business_id", "shortcut");

-- CreateIndex
CREATE INDEX "templates_provider_account_id_idx" ON "templates"("provider_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "templates_business_id_name_language_key" ON "templates"("business_id", "name", "language");

-- CreateIndex
CREATE UNIQUE INDEX "templates_business_id_provider_template_id_key" ON "templates"("business_id", "provider_template_id");

-- CreateIndex
CREATE INDEX "automation_rules_business_id_trigger_is_active_idx" ON "automation_rules"("business_id", "trigger", "is_active");

-- CreateIndex
CREATE INDEX "automation_runs_business_id_status_scheduled_for_idx" ON "automation_runs"("business_id", "status", "scheduled_for");

-- CreateIndex
CREATE INDEX "distribution_lists_business_id_idx" ON "distribution_lists"("business_id");

-- CreateIndex
CREATE INDEX "distribution_list_members_contact_id_idx" ON "distribution_list_members"("contact_id");

-- CreateIndex
CREATE INDEX "campaigns_business_id_status_scheduled_at_idx" ON "campaigns"("business_id", "status", "scheduled_at");

-- CreateIndex
CREATE INDEX "campaigns_list_id_idx" ON "campaigns"("list_id");

-- CreateIndex
CREATE INDEX "campaigns_template_id_idx" ON "campaigns"("template_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipients_message_id_key" ON "campaign_recipients"("message_id");

-- CreateIndex
CREATE INDEX "campaign_recipients_campaign_id_status_idx" ON "campaign_recipients"("campaign_id", "status");

-- CreateIndex
CREATE INDEX "campaign_recipients_status_claimed_at_idx" ON "campaign_recipients"("status", "claimed_at");

-- CreateIndex
CREATE INDEX "campaign_recipients_contact_id_idx" ON "campaign_recipients"("contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipients_campaign_id_contact_id_key" ON "campaign_recipients"("campaign_id", "contact_id");

-- AddForeignKey
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_phones" ADD CONSTRAINT "contact_phones_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_phones" ADD CONSTRAINT "contact_phones_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_emails" ADD CONSTRAINT "contact_emails_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_emails" ADD CONSTRAINT "contact_emails_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_list_lead_id_fkey" FOREIGN KEY ("list_lead_id") REFERENCES "list_leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dnc_entries" ADD CONSTRAINT "dnc_entries_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dnc_entries" ADD CONSTRAINT "dnc_entries_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_jobs" ADD CONSTRAINT "automation_jobs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_jobs" ADD CONSTRAINT "automation_jobs_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "domain_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dial_lists" ADD CONSTRAINT "dial_lists_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dial_lists" ADD CONSTRAINT "dial_lists_script_id_fkey" FOREIGN KEY ("script_id") REFERENCES "scripts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dial_lists" ADD CONSTRAINT "dial_lists_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "phone_numbers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
ALTER TABLE "call_monitors" ADD CONSTRAINT "call_monitors_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_monitors" ADD CONSTRAINT "call_monitors_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_monitors" ADD CONSTRAINT "call_monitors_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telephony_events" ADD CONSTRAINT "telephony_events_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telephony_events" ADD CONSTRAINT "telephony_events_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_provider_credential_id_fkey" FOREIGN KEY ("provider_credential_id") REFERENCES "provider_credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assigned_agent_id_fkey" FOREIGN KEY ("assigned_agent_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sent_by_user_id_fkey" FOREIGN KEY ("sent_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_tags" ADD CONSTRAINT "conversation_tags_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_tags" ADD CONSTRAINT "conversation_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_drafts" ADD CONSTRAINT "conversation_drafts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_drafts" ADD CONSTRAINT "conversation_drafts_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_drafts" ADD CONSTRAINT "conversation_drafts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canned_replies" ADD CONSTRAINT "canned_replies_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canned_replies" ADD CONSTRAINT "canned_replies_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "automation_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distribution_lists" ADD CONSTRAINT "distribution_lists_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distribution_list_members" ADD CONSTRAINT "distribution_list_members_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "distribution_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distribution_list_members" ADD CONSTRAINT "distribution_list_members_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "distribution_lists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_provider_credential_id_fkey" FOREIGN KEY ("provider_credential_id") REFERENCES "provider_credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
