-- Additive only: preserve legacy feedback, snapshots and B01 statuses.
ALTER TABLE "ParentFeedback"
  ADD COLUMN "clientRequestId" TEXT,
  ADD COLUMN "requestFingerprint" TEXT,
  ADD COLUMN "creationReceiptCiphertext" TEXT;
CREATE UNIQUE INDEX "ParentFeedback_teacherId_clientRequestId_key"
  ON "ParentFeedback"("teacherId", "clientRequestId");
ALTER TABLE "FeedbackEvidence"
  ADD COLUMN "sourceVersion" TEXT,
  ADD COLUMN "originalDeletedAtSave" BOOLEAN;
