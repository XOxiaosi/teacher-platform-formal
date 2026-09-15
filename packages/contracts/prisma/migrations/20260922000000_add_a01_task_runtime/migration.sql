-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "nextEventSeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "runtimeOwner" TEXT;

-- AlterTable
ALTER TABLE "ConversationTurn" ADD COLUMN     "eventKey" TEXT,
ADD COLUMN     "eventKind" TEXT,
ADD COLUMN     "executionId" TEXT,
ADD COLUMN     "invalidatedAtTs" TIMESTAMPTZ(3),
ADD COLUMN     "redactedAtTs" TIMESTAMPTZ(3),
ADD COLUMN     "seq" INTEGER,
ADD COLUMN     "taskId" TEXT;

-- AlterTable
ALTER TABLE "AgentExecution" ADD COLUMN     "taskId" TEXT;

-- CreateTable
CREATE TABLE "TaskRuntime" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "originExecutionId" TEXT,
    "currentExecutionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "title" TEXT,
    "runtimeVersion" TEXT NOT NULL DEFAULT 'dsh-v1',
    "dshSessionRef" TEXT,
    "dshCheckpoint" JSONB,
    "contextEpoch" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" TEXT,
    "leaseEpoch" INTEGER NOT NULL DEFAULT 0,
    "leaseExpiresAtTs" TIMESTAMPTZ(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" JSONB,
    "resumeFromVersion" INTEGER,
    "resumeExecutionId" TEXT,
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAtTs" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TaskRuntime_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StepReceipt" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "inputFingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'prepared',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "leaseEpoch" INTEGER NOT NULL,
    "pendingActionId" TEXT,
    "resultRef" JSONB,
    "sourceRefs" JSONB NOT NULL DEFAULT '[]',
    "error" JSONB,
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAtTs" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StepReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskRuntime_originExecutionId_key" ON "TaskRuntime"("originExecutionId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRuntime_dshSessionRef_key" ON "TaskRuntime"("dshSessionRef");

-- CreateIndex
CREATE INDEX "TaskRuntime_teacherId_conversationId_updatedAtTs_id_idx" ON "TaskRuntime"("teacherId", "conversationId", "updatedAtTs", "id");

-- CreateIndex
CREATE INDEX "TaskRuntime_status_leaseExpiresAtTs_idx" ON "TaskRuntime"("status", "leaseExpiresAtTs");

-- CreateIndex
CREATE UNIQUE INDEX "StepReceipt_pendingActionId_key" ON "StepReceipt"("pendingActionId");

-- CreateIndex
CREATE INDEX "StepReceipt_taskId_executionId_idx" ON "StepReceipt"("taskId", "executionId");

-- CreateIndex
CREATE UNIQUE INDEX "StepReceipt_teacherId_taskId_stepKey_key" ON "StepReceipt"("teacherId", "taskId", "stepKey");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationTurn_conversationId_seq_key" ON "ConversationTurn"("conversationId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationTurn_conversationId_eventKey_key" ON "ConversationTurn"("conversationId", "eventKey");

-- CreateIndex
CREATE INDEX "AgentExecution_teacherId_taskId_createdAtTs_id_idx" ON "AgentExecution"("teacherId", "taskId", "createdAtTs", "id");

-- AddForeignKey
ALTER TABLE "AgentExecution" ADD CONSTRAINT "AgentExecution_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "TaskRuntime"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRuntime" ADD CONSTRAINT "TaskRuntime_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepReceipt" ADD CONSTRAINT "StepReceipt_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "TaskRuntime"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepReceipt" ADD CONSTRAINT "StepReceipt_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "AgentExecution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
