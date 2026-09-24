-- CreateEnum
CREATE TYPE "MonitorMode" AS ENUM ('listen', 'whisper');

-- CreateEnum
CREATE TYPE "MonitorStatus" AS ENUM ('connecting', 'listening', 'whispering', 'ended', 'failed');

-- AlterTable
ALTER TABLE "calls" ADD COLUMN     "conference_id" TEXT;

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

-- CreateIndex
CREATE UNIQUE INDEX "call_monitors_active_for_manager_key" ON "call_monitors"("active_for_manager");

-- CreateIndex
CREATE INDEX "call_monitors_call_id_status_idx" ON "call_monitors"("call_id", "status");

-- CreateIndex
CREATE INDEX "call_monitors_leg_id_idx" ON "call_monitors"("leg_id");

-- AddForeignKey
ALTER TABLE "call_monitors" ADD CONSTRAINT "call_monitors_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_monitors" ADD CONSTRAINT "call_monitors_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
