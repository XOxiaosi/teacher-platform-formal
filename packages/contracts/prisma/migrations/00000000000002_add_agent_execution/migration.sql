-- CreateTable
CREATE TABLE "AgentExecution" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "userTurnId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "stage" TEXT NOT NULL DEFAULT 'conversation',
    "reply" TEXT,
    "error" JSONB,
    "completedToolCallIds" JSONB NOT NULL DEFAULT '[]',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentExecution_userTurnId_key" ON "AgentExecution"("userTurnId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentExecution_teacherId_clientRequestId_key" ON "AgentExecution"("teacherId", "clientRequestId");

-- CreateIndex
CREATE INDEX "AgentExecution_conversationId_createdAt_idx" ON "AgentExecution"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentExecution_teacherId_status_updatedAt_idx" ON "AgentExecution"("teacherId", "status", "updatedAt");

-- AddForeignKey
ALTER TABLE "AgentExecution" ADD CONSTRAINT "AgentExecution_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
