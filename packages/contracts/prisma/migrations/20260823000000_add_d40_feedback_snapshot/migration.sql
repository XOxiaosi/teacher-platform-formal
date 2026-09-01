-- CreateTable
CREATE TABLE "FeedbackContextSnapshot" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "feedbackId" TEXT NOT NULL,
    "windowStartTs" TIMESTAMPTZ(3),
    "windowEndTs" TIMESTAMPTZ(3),
    "assembledAtTs" TIMESTAMPTZ(3) NOT NULL,
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAtTs" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "FeedbackContextSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeedbackEvidence" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "recordId" TEXT,
    "type" TEXT NOT NULL,
    "occurredAtTs" TIMESTAMPTZ(3) NOT NULL,
    "category" TEXT,
    "summary" TEXT,
    "examName" TEXT,
    "subject" TEXT,
    "score" DOUBLE PRECISION,
    "fullScore" DOUBLE PRECISION,
    "previousScore" DOUBLE PRECISION,
    "parentConcerns" JSONB NOT NULL DEFAULT '[]',
    "followUps" JSONB NOT NULL DEFAULT '[]',
    "sortOrder" INTEGER NOT NULL,
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedbackEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FeedbackContextSnapshot_feedbackId_key" ON "FeedbackContextSnapshot"("feedbackId");

-- CreateIndex
CREATE INDEX "FeedbackContextSnapshot_teacherId_feedbackId_idx" ON "FeedbackContextSnapshot"("teacherId", "feedbackId");

-- CreateIndex
CREATE INDEX "FeedbackContextSnapshot_teacherId_idx" ON "FeedbackContextSnapshot"("teacherId");

-- CreateIndex
CREATE INDEX "FeedbackEvidence_teacherId_snapshotId_idx" ON "FeedbackEvidence"("teacherId", "snapshotId");

-- CreateIndex
CREATE INDEX "FeedbackEvidence_teacherId_idx" ON "FeedbackEvidence"("teacherId");

-- AddForeignKey
ALTER TABLE "FeedbackContextSnapshot" ADD CONSTRAINT "FeedbackContextSnapshot_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "ParentFeedback"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackEvidence" ADD CONSTRAINT "FeedbackEvidence_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "FeedbackContextSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
