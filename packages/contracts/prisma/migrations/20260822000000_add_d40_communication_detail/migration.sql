-- CreateTable
CREATE TABLE "CommunicationDetail" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "studentRecordId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "channel" TEXT,
    "parentType" TEXT,
    "parentConcerns" JSONB NOT NULL DEFAULT '[]',
    "teacherResponses" JSONB NOT NULL DEFAULT '[]',
    "agreements" JSONB NOT NULL DEFAULT '[]',
    "followUps" JSONB NOT NULL DEFAULT '[]',
    "nextContactAtTs" TIMESTAMPTZ(3),
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAtTs" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CommunicationDetail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationDetail_studentRecordId_key" ON "CommunicationDetail"("studentRecordId");

-- CreateIndex
CREATE INDEX "CommunicationDetail_teacherId_studentRecordId_idx" ON "CommunicationDetail"("teacherId", "studentRecordId");

-- CreateIndex
CREATE INDEX "CommunicationDetail_teacherId_idx" ON "CommunicationDetail"("teacherId");

-- AddForeignKey
ALTER TABLE "CommunicationDetail" ADD CONSTRAINT "CommunicationDetail_studentRecordId_fkey" FOREIGN KEY ("studentRecordId") REFERENCES "StudentRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
