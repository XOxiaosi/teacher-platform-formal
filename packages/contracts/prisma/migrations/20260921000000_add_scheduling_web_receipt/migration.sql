-- Separate replay receipts prevent a retry from being interpreted as a second
-- scheduling mutation or as a workspace-web request with a coincident key.
CREATE TABLE "SchedulingWebMutationReceipt" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SchedulingWebMutationReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SchedulingWebMutationReceipt_teacherId_clientRequestId_key"
  ON "SchedulingWebMutationReceipt"("teacherId", "clientRequestId");
