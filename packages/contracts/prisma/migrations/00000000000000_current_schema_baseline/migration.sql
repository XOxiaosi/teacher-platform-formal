-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Student" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "source" TEXT,
    "currentStatus" TEXT NOT NULL DEFAULT 'active',
    "stageGoal" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Student_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Schedule" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "studentId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "scheduledStart" TIMESTAMP(3) NOT NULL,
    "scheduledEnd" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "confidence" TEXT,
    "pendingFields" JSONB,
    "sourceInput" TEXT,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lesson" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "progress" TEXT,
    "studentState" TEXT,
    "homework" TEXT,
    "teacherNote" TEXT,
    "sourceNoteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lesson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AINote" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "inputType" TEXT NOT NULL,
    "rawInput" TEXT NOT NULL,
    "audioFileRef" TEXT,
    "intent" TEXT,
    "extractedData" JSONB,
    "confidence" TEXT,
    "pendingFields" JSONB,
    "routedTo" TEXT,
    "routedModuleId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AINote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationTurn" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "toolCalls" JSONB,
    "toolResults" JSONB,
    "audioFileRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationTurn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "lessonCount" INTEGER NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyReview" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "plannedCount" INTEGER NOT NULL DEFAULT 0,
    "actualCount" INTEGER NOT NULL DEFAULT 0,
    "cancelledCount" INTEGER NOT NULL DEFAULT 0,
    "missedCount" INTEGER NOT NULL DEFAULT 0,
    "rescheduledCount" INTEGER NOT NULL DEFAULT 0,
    "pendingCount" INTEGER NOT NULL DEFAULT 0,
    "deviations" JSONB,
    "corrections" JSONB,
    "tomorrowSuggestion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushRecord" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "channel" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMsg" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeLog" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "module" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "diff" JSONB,
    "source" TEXT NOT NULL,
    "operatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChangeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Memo" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "dueAt" TIMESTAMP(3),
    "tags" JSONB,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Memo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParentFeedback" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "lessonId" TEXT,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "channel" TEXT,
    "parentName" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ParentFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Student_teacherId_idx" ON "Student"("teacherId");

-- CreateIndex
CREATE INDEX "Schedule_teacherId_idx" ON "Schedule"("teacherId");

-- CreateIndex
CREATE INDEX "Schedule_studentId_idx" ON "Schedule"("studentId");

-- CreateIndex
CREATE INDEX "Schedule_teacherId_scheduledStart_idx" ON "Schedule"("teacherId", "scheduledStart");

-- CreateIndex
CREATE INDEX "Lesson_teacherId_idx" ON "Lesson"("teacherId");

-- CreateIndex
CREATE INDEX "Lesson_studentId_idx" ON "Lesson"("studentId");

-- CreateIndex
CREATE INDEX "Lesson_studentId_status_idx" ON "Lesson"("studentId", "status");

-- CreateIndex
CREATE INDEX "AINote_teacherId_idx" ON "AINote"("teacherId");

-- CreateIndex
CREATE INDEX "Conversation_teacherId_idx" ON "Conversation"("teacherId");

-- CreateIndex
CREATE INDEX "Conversation_teacherId_status_idx" ON "Conversation"("teacherId", "status");

-- CreateIndex
CREATE INDEX "ConversationTurn_conversationId_idx" ON "ConversationTurn"("conversationId");

-- CreateIndex
CREATE INDEX "ConversationTurn_teacherId_idx" ON "ConversationTurn"("teacherId");

-- CreateIndex
CREATE INDEX "Payment_teacherId_idx" ON "Payment"("teacherId");

-- CreateIndex
CREATE INDEX "Payment_studentId_idx" ON "Payment"("studentId");

-- CreateIndex
CREATE INDEX "DailyReview_teacherId_idx" ON "DailyReview"("teacherId");

-- CreateIndex
CREATE UNIQUE INDEX "DailyReview_teacherId_date_key" ON "DailyReview"("teacherId", "date");

-- CreateIndex
CREATE INDEX "PushRecord_teacherId_idx" ON "PushRecord"("teacherId");

-- CreateIndex
CREATE INDEX "PushRecord_status_idx" ON "PushRecord"("status");

-- CreateIndex
CREATE INDEX "ChangeLog_teacherId_idx" ON "ChangeLog"("teacherId");

-- CreateIndex
CREATE INDEX "ChangeLog_module_idx" ON "ChangeLog"("module");

-- CreateIndex
CREATE INDEX "ChangeLog_targetType_targetId_idx" ON "ChangeLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "ChangeLog_timestamp_idx" ON "ChangeLog"("timestamp");

-- CreateIndex
CREATE INDEX "Memo_teacherId_status_idx" ON "Memo"("teacherId", "status");

-- CreateIndex
CREATE INDEX "Memo_teacherId_dueAt_idx" ON "Memo"("teacherId", "dueAt");

-- CreateIndex
CREATE INDEX "Memo_teacherId_createdAt_idx" ON "Memo"("teacherId", "createdAt");

-- CreateIndex
CREATE INDEX "ParentFeedback_teacherId_status_idx" ON "ParentFeedback"("teacherId", "status");

-- CreateIndex
CREATE INDEX "ParentFeedback_studentId_idx" ON "ParentFeedback"("studentId");

-- CreateIndex
CREATE INDEX "ParentFeedback_lessonId_idx" ON "ParentFeedback"("lessonId");

-- CreateIndex
CREATE INDEX "ParentFeedback_teacherId_createdAt_idx" ON "ParentFeedback"("teacherId", "createdAt");

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Schedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lesson" ADD CONSTRAINT "Lesson_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lesson" ADD CONSTRAINT "Lesson_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "Schedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationTurn" ADD CONSTRAINT "ConversationTurn_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParentFeedback" ADD CONSTRAINT "ParentFeedback_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParentFeedback" ADD CONSTRAINT "ParentFeedback_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE SET NULL ON UPDATE CASCADE;
