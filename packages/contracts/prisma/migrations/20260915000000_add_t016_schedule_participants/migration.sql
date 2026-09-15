-- T-016: structured web course scheduling. Legacy title/studentId are retained for compatibility.
ALTER TABLE "Schedule"
  ADD COLUMN "locationCiphertext" TEXT,
  ADD COLUMN "classFormat" TEXT,
  ADD COLUMN "operationalNoteCiphertext" TEXT,
  ADD COLUMN "clientRequestId" TEXT;

CREATE TABLE "ScheduleParticipant" (
  "id" TEXT NOT NULL,
  "teacherId" TEXT NOT NULL,
  "scheduleId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAtTs" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ScheduleParticipant_pkey" PRIMARY KEY ("id")
);

-- Safely preserve historical single-student schedules as a one-member relation.
INSERT INTO "ScheduleParticipant" ("id", "teacherId", "scheduleId", "studentId", "createdAtTs", "updatedAtTs")
SELECT ('t016_' || "id"), "teacherId", "id", "studentId", "createdAtTs", "updatedAtTs"
FROM "Schedule"
WHERE "studentId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "Student"
    WHERE "Student"."id" = "Schedule"."studentId"
      AND "Student"."teacherId" = "Schedule"."teacherId"
  );

CREATE UNIQUE INDEX "ScheduleParticipant_scheduleId_studentId_key" ON "ScheduleParticipant"("scheduleId", "studentId");
CREATE INDEX "ScheduleParticipant_teacherId_scheduleId_idx" ON "ScheduleParticipant"("teacherId", "scheduleId");
CREATE INDEX "ScheduleParticipant_teacherId_studentId_idx" ON "ScheduleParticipant"("teacherId", "studentId");
CREATE INDEX "Schedule_teacherId_scheduledStartTs_idx" ON "Schedule"("teacherId", "scheduledStartTs");
CREATE UNIQUE INDEX "Schedule_teacherId_clientRequestId_key" ON "Schedule"("teacherId", "clientRequestId");

ALTER TABLE "ScheduleParticipant" ADD CONSTRAINT "ScheduleParticipant_scheduleId_fkey"
  FOREIGN KEY ("scheduleId") REFERENCES "Schedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduleParticipant" ADD CONSTRAINT "ScheduleParticipant_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Lesson_scheduleId_studentId_key" ON "Lesson"("scheduleId", "studentId");

ALTER TABLE "CaptureCandidate"
  ADD COLUMN "confirmationRequestId" TEXT,
  ADD COLUMN "confirmedRecordId" TEXT,
  ADD COLUMN "confirmedAtTs" TIMESTAMPTZ(3);
CREATE UNIQUE INDEX "CaptureCandidate_teacherId_confirmationRequestId_key"
  ON "CaptureCandidate"("teacherId", "confirmationRequestId");
