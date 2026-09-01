-- CreateTable
CREATE TABLE "PendingAction" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "toolCallId" TEXT NOT NULL,
    "actionName" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "parameters" JSONB NOT NULL,
    "beforeSummary" TEXT,
    "afterSummary" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingAction_teacherId_status_expiresAt_idx" ON "PendingAction"("teacherId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "PendingAction_conversationId_idx" ON "PendingAction"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "PendingAction_teacherId_toolCallId_key" ON "PendingAction"("teacherId", "toolCallId");

-- AddForeignKey
ALTER TABLE "PendingAction" ADD CONSTRAINT "PendingAction_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
