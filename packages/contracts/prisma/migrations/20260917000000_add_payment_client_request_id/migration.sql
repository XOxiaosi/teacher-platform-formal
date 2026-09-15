ALTER TABLE "Payment" ADD COLUMN "clientRequestId" TEXT;

CREATE UNIQUE INDEX "Payment_teacherId_clientRequestId_key"
ON "Payment"("teacherId", "clientRequestId");
