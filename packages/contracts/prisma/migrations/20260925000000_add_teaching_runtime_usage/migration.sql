-- Add durable teaching-runtime usage fields while preserving legacy routing rows.
ALTER TABLE "ProviderUsage"
  ADD COLUMN "taskId" TEXT,
  ADD COLUMN "executionId" TEXT,
  ADD COLUMN "sessionId" TEXT,
  ADD COLUMN "eventKey" TEXT,
  ADD COLUMN "outcome" TEXT,
  ADD COLUMN "usageStatus" TEXT,
  ADD COLUMN "synthetic" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "ProviderUsage_teacherId_taskId_executionId_idx"
  ON "ProviderUsage"("teacherId", "taskId", "executionId");

CREATE UNIQUE INDEX "ProviderUsage_teacherId_eventKey_key"
  ON "ProviderUsage"("teacherId", "eventKey");
