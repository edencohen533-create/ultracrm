-- "נתקעתי? שאל את ה-AI": per-call chat between the agent and the coach.
CREATE TABLE "coach_chat_messages" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "call_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "follow_up" TEXT,
    "why" TEXT,
    "basis" TEXT,
    "sources" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_chat_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "coach_chat_messages_session_id_created_at_idx" ON "coach_chat_messages"("session_id", "created_at");
CREATE INDEX "coach_chat_messages_business_id_created_at_idx" ON "coach_chat_messages"("business_id", "created_at");

ALTER TABLE "coach_chat_messages" ADD CONSTRAINT "coach_chat_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "coach_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "coach_chat_messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "coach_chat_messages" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
