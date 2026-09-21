BEGIN;

CREATE TABLE "FeedbackDraftTask" (
  "id" TEXT NOT NULL,
  "teacherId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "clientRequestId" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "version" INTEGER NOT NULL DEFAULT 1,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "retryable" BOOLEAN NOT NULL DEFAULT false,
  "requestCiphertext" TEXT NOT NULL,
  "draftCiphertext" TEXT,
  "generationCiphertext" TEXT,
  "errorCiphertext" TEXT,
  "savedFeedbackId" TEXT,
  "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAtTs" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "FeedbackDraftTask_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "FeedbackDraftAttempt" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "teacherId" TEXT NOT NULL,
  "clientRequestId" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "modelCallStartedAtTs" TIMESTAMPTZ(3),
  "modelCallEndedAtTs" TIMESTAMPTZ(3),
  "resultCiphertext" TEXT,
  "errorCiphertext" TEXT,
  "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAtTs" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "FeedbackDraftAttempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FeedbackDraftTask_teacherId_clientRequestId_key" ON "FeedbackDraftTask"("teacherId", "clientRequestId");
CREATE UNIQUE INDEX "FeedbackDraftTask_savedFeedbackId_key" ON "FeedbackDraftTask"("savedFeedbackId");
CREATE INDEX "FeedbackDraftTask_teacherId_studentId_status_updatedAtTs_idx" ON "FeedbackDraftTask"("teacherId", "studentId", "status", "updatedAtTs");
CREATE UNIQUE INDEX "FeedbackDraftAttempt_taskId_clientRequestId_key" ON "FeedbackDraftAttempt"("taskId", "clientRequestId");
CREATE INDEX "FeedbackDraftAttempt_teacherId_taskId_createdAtTs_idx" ON "FeedbackDraftAttempt"("teacherId", "taskId", "createdAtTs");
ALTER TABLE "FeedbackDraftTask" ADD CONSTRAINT "FeedbackDraftTask_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FeedbackDraftTask" ADD CONSTRAINT "FeedbackDraftTask_savedFeedbackId_fkey" FOREIGN KEY ("savedFeedbackId") REFERENCES "ParentFeedback"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FeedbackDraftAttempt" ADD CONSTRAINT "FeedbackDraftAttempt_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "FeedbackDraftTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
COMMIT;
