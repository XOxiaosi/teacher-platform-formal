CREATE TABLE "LessonStatusCorrectionConfirmation" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "reasonCiphertext" TEXT NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expectedLessonUpdatedAtTs" TIMESTAMPTZ(3) NOT NULL,
    "confirmedAtTs" TIMESTAMPTZ(3),
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAtTs" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "LessonStatusCorrectionConfirmation_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "LessonLedgerEntry"
  ADD COLUMN "statusCorrectionConfirmationId" TEXT;

CREATE UNIQUE INDEX "LessonStatusCorrectionConfirmation_teacherId_clientRequestId_key"
  ON "LessonStatusCorrectionConfirmation"("teacherId", "clientRequestId");
CREATE INDEX "LessonStatusCorrectionConfirmation_teacher_lesson_version_idx"
  ON "LessonStatusCorrectionConfirmation"("teacherId", "lessonId", "expectedLessonUpdatedAtTs");
CREATE INDEX "LessonStatusCorrectionConfirmation_teacherId_studentId_createdAtTs_idx"
  ON "LessonStatusCorrectionConfirmation"("teacherId", "studentId", "createdAtTs");
CREATE UNIQUE INDEX "LessonLedgerEntry_statusCorrectionConfirmationId_key"
  ON "LessonLedgerEntry"("statusCorrectionConfirmationId");

ALTER TABLE "LessonStatusCorrectionConfirmation"
  ADD CONSTRAINT "LessonStatusCorrectionConfirmation_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LessonStatusCorrectionConfirmation"
  ADD CONSTRAINT "LessonStatusCorrectionConfirmation_lessonId_fkey"
  FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LessonLedgerEntry"
  ADD CONSTRAINT "LessonLedgerEntry_statusCorrectionConfirmationId_fkey"
  FOREIGN KEY ("statusCorrectionConfirmationId") REFERENCES "LessonStatusCorrectionConfirmation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
