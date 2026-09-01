-- CreateTable
CREATE TABLE "StudentSourceRecord" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "studentId" TEXT,
    "sourceType" TEXT NOT NULL,
    "sourceEntityType" TEXT,
    "sourceEntityId" TEXT,
    "occurredAtTs" TIMESTAMPTZ(3) NOT NULL,
    "rawText" TEXT,
    "contentHash" TEXT,
    "captureStatus" TEXT NOT NULL DEFAULT 'captured',
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAtTs" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StudentSourceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentRecord" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "sourceRecordId" TEXT,
    "category" TEXT NOT NULL,
    "occurredAtTs" TIMESTAMPTZ(3) NOT NULL,
    "summary" TEXT NOT NULL,
    "structuredData" JSONB,
    "confidence" TEXT NOT NULL DEFAULT 'medium',
    "reviewStatus" TEXT NOT NULL DEFAULT 'candidate',
    "visibility" TEXT NOT NULL DEFAULT 'needs_review',
    "importance" TEXT NOT NULL DEFAULT 'normal',
    "supersedesId" TEXT,
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAtTs" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StudentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentDetail" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "studentRecordId" TEXT NOT NULL,
    "examName" TEXT,
    "subject" TEXT,
    "examDateTs" TIMESTAMPTZ(3),
    "score" DOUBLE PRECISION,
    "fullScore" DOUBLE PRECISION,
    "classRank" INTEGER,
    "gradeRank" INTEGER,
    "percentile" DOUBLE PRECISION,
    "previousScore" DOUBLE PRECISION,
    "note" TEXT,
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAtTs" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AssessmentDetail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StudentSourceRecord_teacherId_captureStatus_idx" ON "StudentSourceRecord"("teacherId", "captureStatus");

-- CreateIndex
CREATE INDEX "StudentSourceRecord_studentId_idx" ON "StudentSourceRecord"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentSourceRecord_teacherId_sourceEntityType_sourceEntity_key" ON "StudentSourceRecord"("teacherId", "sourceEntityType", "sourceEntityId");

-- CreateIndex
CREATE INDEX "StudentRecord_teacherId_reviewStatus_idx" ON "StudentRecord"("teacherId", "reviewStatus");

-- CreateIndex
CREATE INDEX "StudentRecord_studentId_occurredAtTs_idx" ON "StudentRecord"("studentId", "occurredAtTs");

-- CreateIndex
CREATE INDEX "StudentRecord_sourceRecordId_idx" ON "StudentRecord"("sourceRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentDetail_studentRecordId_key" ON "AssessmentDetail"("studentRecordId");

-- CreateIndex
CREATE INDEX "AssessmentDetail_teacherId_idx" ON "AssessmentDetail"("teacherId");

-- AddForeignKey
ALTER TABLE "StudentSourceRecord" ADD CONSTRAINT "StudentSourceRecord_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentRecord" ADD CONSTRAINT "StudentRecord_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentRecord" ADD CONSTRAINT "StudentRecord_sourceRecordId_fkey" FOREIGN KEY ("sourceRecordId") REFERENCES "StudentSourceRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentRecord" ADD CONSTRAINT "StudentRecord_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "StudentRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentDetail" ADD CONSTRAINT "AssessmentDetail_studentRecordId_fkey" FOREIGN KEY ("studentRecordId") REFERENCES "StudentRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
