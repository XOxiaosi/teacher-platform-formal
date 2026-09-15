-- T-017: append-only lesson-credit ledger. A balance is derived from ledger
-- entries plus legacy Payment rows that have no corresponding purchase entry.
CREATE TABLE "LessonLedgerEntry" (
  "id" TEXT NOT NULL,
  "teacherId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "entryType" TEXT NOT NULL,
  "lessonDelta" INTEGER NOT NULL,
  "amount" DOUBLE PRECISION,
  "reasonCiphertext" TEXT,
  "paymentId" TEXT,
  "lessonId" TEXT,
  "adjustmentConfirmationId" TEXT,
  "clientRequestId" TEXT,
  "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LessonLedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LessonLedgerAdjustmentConfirmation" (
  "id" TEXT NOT NULL,
  "teacherId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "entryType" TEXT NOT NULL,
  "lessonDelta" INTEGER NOT NULL,
  "reasonCiphertext" TEXT NOT NULL,
  "clientRequestId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "confirmedAtTs" TIMESTAMPTZ(3),
  "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAtTs" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "LessonLedgerAdjustmentConfirmation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LessonLedgerEntry_paymentId_key" ON "LessonLedgerEntry"("paymentId");
CREATE UNIQUE INDEX "LessonLedgerEntry_lessonId_key" ON "LessonLedgerEntry"("lessonId");
CREATE UNIQUE INDEX "LessonLedgerEntry_adjustmentConfirmationId_key" ON "LessonLedgerEntry"("adjustmentConfirmationId");
CREATE UNIQUE INDEX "LessonLedgerEntry_teacherId_clientRequestId_key" ON "LessonLedgerEntry"("teacherId", "clientRequestId");
CREATE INDEX "LessonLedgerEntry_teacherId_studentId_createdAtTs_idx" ON "LessonLedgerEntry"("teacherId", "studentId", "createdAtTs");
CREATE INDEX "LessonLedgerEntry_studentId_idx" ON "LessonLedgerEntry"("studentId");
CREATE UNIQUE INDEX "LessonLedgerAdjustmentConfirmation_teacherId_clientRequestId_key" ON "LessonLedgerAdjustmentConfirmation"("teacherId", "clientRequestId");
CREATE INDEX "LessonLedgerAdjustmentConfirmation_teacherId_studentId_createdAtTs_idx" ON "LessonLedgerAdjustmentConfirmation"("teacherId", "studentId", "createdAtTs");

ALTER TABLE "LessonLedgerEntry" ADD CONSTRAINT "LessonLedgerEntry_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LessonLedgerEntry" ADD CONSTRAINT "LessonLedgerEntry_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LessonLedgerEntry" ADD CONSTRAINT "LessonLedgerEntry_lessonId_fkey"
  FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LessonLedgerEntry" ADD CONSTRAINT "LessonLedgerEntry_adjustmentConfirmationId_fkey"
  FOREIGN KEY ("adjustmentConfirmationId") REFERENCES "LessonLedgerAdjustmentConfirmation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LessonLedgerAdjustmentConfirmation" ADD CONSTRAINT "LessonLedgerAdjustmentConfirmation_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Existing payments become formal purchase entries once. This makes the
-- post-migration balance derived wholly from the immutable ledger while still
-- accepting historical Payment rows in environments which have not yet run it.
INSERT INTO "LessonLedgerEntry" ("id", "teacherId", "studentId", "entryType", "lessonDelta", "amount", "paymentId", "createdAtTs")
SELECT ('t017_payment_' || "id"), "teacherId", "studentId", 'purchase', "lessonCount", "amount", "id", "createdAtTs"
FROM "Payment";
