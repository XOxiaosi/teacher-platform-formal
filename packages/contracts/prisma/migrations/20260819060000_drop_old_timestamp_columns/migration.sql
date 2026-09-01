-- DropIndex
DROP INDEX "AgentExecution_conversationId_createdAt_idx";

-- DropIndex
DROP INDEX "AgentExecution_teacherId_status_updatedAt_idx";

-- DropIndex
DROP INDEX "ChangeLog_timestamp_idx";

-- DropIndex
DROP INDEX "DailyReview_teacherId_date_key";

-- DropIndex
DROP INDEX "Memo_teacherId_createdAt_idx";

-- DropIndex
DROP INDEX "Memo_teacherId_dueAt_idx";

-- DropIndex
DROP INDEX "ParentFeedback_teacherId_createdAt_idx";

-- DropIndex
DROP INDEX "PendingAction_teacherId_status_expiresAt_idx";

-- DropIndex
DROP INDEX "Schedule_teacherId_scheduledStart_idx";

-- AlterTable
ALTER TABLE "AINote" DROP COLUMN "createdAt",
DROP COLUMN "updatedAt",
ALTER COLUMN "createdAtTs" SET NOT NULL,
ALTER COLUMN "createdAtTs" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "updatedAtTs" SET NOT NULL;

-- AlterTable
ALTER TABLE "AgentExecution" DROP COLUMN "createdAt",
DROP COLUMN "finishedAt",
DROP COLUMN "startedAt",
DROP COLUMN "updatedAt",
ALTER COLUMN "createdAtTs" SET NOT NULL,
ALTER COLUMN "createdAtTs" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "startedAtTs" SET NOT NULL,
ALTER COLUMN "startedAtTs" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "updatedAtTs" SET NOT NULL;

-- AlterTable
ALTER TABLE "ChangeLog" DROP COLUMN "createdAt",
DROP COLUMN "timestamp",
ALTER COLUMN "createdAtTs" SET NOT NULL,
ALTER COLUMN "createdAtTs" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "timestampTs" SET NOT NULL,
ALTER COLUMN "timestampTs" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Conversation" DROP COLUMN "createdAt",
DROP COLUMN "updatedAt",
ALTER COLUMN "createdAtTs" SET NOT NULL,
ALTER COLUMN "createdAtTs" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "updatedAtTs" SET NOT NULL;

-- AlterTable
ALTER TABLE "ConversationTurn" DROP COLUMN "createdAt",
ALTER COLUMN "createdAtTs" SET NOT NULL,
ALTER COLUMN "createdAtTs" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "DailyReview" DROP COLUMN "createdAt",
DROP COLUMN "date",
DROP COLUMN "updatedAt",
ALTER COLUMN "createdAtTs" SET NOT NULL,
ALTER COLUMN "createdAtTs" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "dateTs" SET NOT NULL,
ALTER COLUMN "updatedAtTs" SET NOT NULL;

-- AlterTable
ALTER TABLE "Lesson" DROP COLUMN "createdAt",
DROP COLUMN "date",
DROP COLUMN "updatedAt",
ALTER COLUMN "createdAtTs" SET NOT NULL,
ALTER COLUMN "createdAtTs" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "dateTs" SET NOT NULL,
ALTER COLUMN "updatedAtTs" SET NOT NULL;

-- AlterTable
ALTER TABLE "Memo" DROP COLUMN "createdAt",
DROP COLUMN "dueAt",
DROP COLUMN "updatedAt",
ALTER COLUMN "createdAtTs" SET NOT NULL,
ALTER COLUMN "createdAtTs" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "updatedAtTs" SET NOT NULL;

-- AlterTable
ALTER TABLE "ParentFeedback" DROP COLUMN "createdAt",
DROP COLUMN "sentAt",
DROP COLUMN "updatedAt",
ALTER COLUMN "createdAtTs" SET NOT NULL,
ALTER COLUMN "createdAtTs" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "updatedAtTs" SET NOT NULL;

-- AlterTable
ALTER TABLE "Payment" DROP COLUMN "createdAt",
DROP COLUMN "paidAt",
DROP COLUMN "updatedAt",
ALTER COLUMN "createdAtTs" SET NOT NULL,
ALTER COLUMN "createdAtTs" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "paidAtTs" SET NOT NULL,
ALTER COLUMN "updatedAtTs" SET NOT NULL;

-- AlterTable
ALTER TABLE "PendingAction" DROP COLUMN "cancelledAt",
DROP COLUMN "consumedAt",
DROP COLUMN "createdAt",
DROP COLUMN "expiresAt",
DROP COLUMN "updatedAt",
ALTER COLUMN "createdAtTs" SET NOT NULL,
ALTER COLUMN "createdAtTs" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "expiresAtTs" SET NOT NULL,
ALTER COLUMN "updatedAtTs" SET NOT NULL;

-- AlterTable
ALTER TABLE "PushRecord" DROP COLUMN "createdAt",
DROP COLUMN "scheduledAt",
DROP COLUMN "sentAt",
DROP COLUMN "updatedAt",
ALTER COLUMN "createdAtTs" SET NOT NULL,
ALTER COLUMN "createdAtTs" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "scheduledAtTs" SET NOT NULL,
ALTER COLUMN "updatedAtTs" SET NOT NULL;

-- AlterTable
ALTER TABLE "Schedule" DROP COLUMN "createdAt",
DROP COLUMN "scheduledEnd",
DROP COLUMN "scheduledStart",
DROP COLUMN "updatedAt",
ALTER COLUMN "createdAtTs" SET NOT NULL,
ALTER COLUMN "createdAtTs" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "scheduledEndTs" SET NOT NULL,
ALTER COLUMN "scheduledStartTs" SET NOT NULL,
ALTER COLUMN "updatedAtTs" SET NOT NULL;

-- AlterTable
ALTER TABLE "Student" DROP COLUMN "createdAt",
DROP COLUMN "updatedAt",
ALTER COLUMN "createdAtTs" SET NOT NULL,
ALTER COLUMN "createdAtTs" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "updatedAtTs" SET NOT NULL;

-- CreateIndex
CREATE INDEX "AgentExecution_conversationId_createdAtTs_idx" ON "AgentExecution"("conversationId", "createdAtTs");

-- CreateIndex
CREATE INDEX "AgentExecution_teacherId_status_updatedAtTs_idx" ON "AgentExecution"("teacherId", "status", "updatedAtTs");

-- CreateIndex
CREATE INDEX "ChangeLog_timestampTs_idx" ON "ChangeLog"("timestampTs");

-- CreateIndex
CREATE UNIQUE INDEX "DailyReview_teacherId_dateTs_key" ON "DailyReview"("teacherId", "dateTs");

-- CreateIndex
CREATE INDEX "Memo_teacherId_dueAtTs_idx" ON "Memo"("teacherId", "dueAtTs");

-- CreateIndex
CREATE INDEX "Memo_teacherId_createdAtTs_idx" ON "Memo"("teacherId", "createdAtTs");

-- CreateIndex
CREATE INDEX "ParentFeedback_teacherId_createdAtTs_idx" ON "ParentFeedback"("teacherId", "createdAtTs");

-- CreateIndex
CREATE INDEX "PendingAction_teacherId_status_expiresAtTs_idx" ON "PendingAction"("teacherId", "status", "expiresAtTs");

-- CreateIndex
CREATE INDEX "Schedule_teacherId_scheduledStartTs_idx" ON "Schedule"("teacherId", "scheduledStartTs");
