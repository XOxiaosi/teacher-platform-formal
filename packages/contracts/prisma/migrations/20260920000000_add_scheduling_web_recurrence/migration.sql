-- Scheduling Web: additive recurrence and completed-revision storage.
-- Existing Schedule / Lesson / LessonLedgerEntry rows remain authoritative.

ALTER TABLE "Schedule"
  ADD COLUMN "recurrenceRuleId" TEXT,
  ADD COLUMN "recurrenceDay" DATE;

CREATE TABLE "RecurrenceRule" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "clientRequestId" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "weekdays" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "locationCiphertext" TEXT NOT NULL,
    "classFormat" TEXT NOT NULL,
    "operationalNoteCiphertext" TEXT,
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAtTs" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "RecurrenceRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecurrenceRuleParticipant" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "recurrenceRuleId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecurrenceRuleParticipant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScheduleRevision" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "clientRequestId" TEXT,
    "beforeCiphertext" TEXT NOT NULL,
    "afterCiphertext" TEXT NOT NULL,
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScheduleRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Schedule_teacherId_recurrenceRuleId_recurrenceDay_key"
  ON "Schedule"("teacherId", "recurrenceRuleId", "recurrenceDay");
CREATE INDEX "Schedule_teacherId_recurrenceRuleId_recurrenceDay_idx"
  ON "Schedule"("teacherId", "recurrenceRuleId", "recurrenceDay");
CREATE UNIQUE INDEX "RecurrenceRule_teacherId_clientRequestId_key"
  ON "RecurrenceRule"("teacherId", "clientRequestId");
CREATE INDEX "RecurrenceRule_teacherId_enabled_startDate_endDate_idx"
  ON "RecurrenceRule"("teacherId", "enabled", "startDate", "endDate");
CREATE UNIQUE INDEX "RecurrenceRuleParticipant_recurrenceRuleId_studentId_key"
  ON "RecurrenceRuleParticipant"("recurrenceRuleId", "studentId");
CREATE INDEX "RecurrenceRuleParticipant_teacherId_recurrenceRuleId_idx"
  ON "RecurrenceRuleParticipant"("teacherId", "recurrenceRuleId");
CREATE INDEX "RecurrenceRuleParticipant_teacherId_studentId_idx"
  ON "RecurrenceRuleParticipant"("teacherId", "studentId");
CREATE UNIQUE INDEX "ScheduleRevision_teacherId_scheduleId_clientRequestId_key"
  ON "ScheduleRevision"("teacherId", "scheduleId", "clientRequestId");
CREATE INDEX "ScheduleRevision_teacherId_scheduleId_createdAtTs_idx"
  ON "ScheduleRevision"("teacherId", "scheduleId", "createdAtTs");

ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_recurrenceRuleId_fkey"
  FOREIGN KEY ("recurrenceRuleId") REFERENCES "RecurrenceRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecurrenceRuleParticipant" ADD CONSTRAINT "RecurrenceRuleParticipant_recurrenceRuleId_fkey"
  FOREIGN KEY ("recurrenceRuleId") REFERENCES "RecurrenceRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecurrenceRuleParticipant" ADD CONSTRAINT "RecurrenceRuleParticipant_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScheduleRevision" ADD CONSTRAINT "ScheduleRevision_scheduleId_fkey"
  FOREIGN KEY ("scheduleId") REFERENCES "Schedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ScheduleCompletionSnapshot" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "lessonLedgerEntryId" TEXT NOT NULL,
    "balanceBefore" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScheduleCompletionSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TeacherWorkspacePreference" (
    "teacherId" TEXT NOT NULL,
    "studioName" TEXT NOT NULL DEFAULT '教师工作室',
    "modelChoice" TEXT NOT NULL DEFAULT 'default',
    "wechatChannel" TEXT NOT NULL DEFAULT 'personal',
    "updatedAtTs" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "TeacherWorkspacePreference_pkey" PRIMARY KEY ("teacherId")
);

CREATE TABLE "WebMutationReceipt" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebMutationReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScheduleCompletionSnapshot_scheduleId_studentId_key"
  ON "ScheduleCompletionSnapshot"("scheduleId", "studentId");
CREATE UNIQUE INDEX "ScheduleCompletionSnapshot_lessonLedgerEntryId_key"
  ON "ScheduleCompletionSnapshot"("lessonLedgerEntryId");
CREATE INDEX "ScheduleCompletionSnapshot_teacherId_scheduleId_idx"
  ON "ScheduleCompletionSnapshot"("teacherId", "scheduleId");
CREATE UNIQUE INDEX "WebMutationReceipt_teacherId_clientRequestId_key"
  ON "WebMutationReceipt"("teacherId", "clientRequestId");

ALTER TABLE "ScheduleCompletionSnapshot" ADD CONSTRAINT "ScheduleCompletionSnapshot_scheduleId_fkey"
  FOREIGN KEY ("scheduleId") REFERENCES "Schedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScheduleCompletionSnapshot" ADD CONSTRAINT "ScheduleCompletionSnapshot_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScheduleCompletionSnapshot" ADD CONSTRAINT "ScheduleCompletionSnapshot_lessonId_fkey"
  FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScheduleCompletionSnapshot" ADD CONSTRAINT "ScheduleCompletionSnapshot_lessonLedgerEntryId_fkey"
  FOREIGN KEY ("lessonLedgerEntryId") REFERENCES "LessonLedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
