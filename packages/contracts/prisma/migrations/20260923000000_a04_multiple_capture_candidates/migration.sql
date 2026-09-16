BEGIN;
-- Keep historical candidate IDs and confirmation relationships unchanged.
ALTER TABLE "CaptureCandidate" ADD COLUMN "originalPayload" JSONB,
  ADD COLUMN "confirmationRevision" INTEGER,
  ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
UPDATE "CaptureCandidate" SET "originalPayload" = "payload";
DROP INDEX "CaptureCandidate_eventId_key";
DROP INDEX "CaptureCandidate_taskId_key";
CREATE UNIQUE INDEX "CaptureCandidate_eventId_position_key" ON "CaptureCandidate"("eventId", "position");
CREATE INDEX "CaptureCandidate_taskId_idx" ON "CaptureCandidate"("taskId");
COMMIT;
