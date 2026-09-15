-- T-015: Web text capture lifecycle. Sensitive fields are encrypted by the application FieldCipher.
CREATE TABLE "CaptureEvent" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceChannel" TEXT NOT NULL DEFAULT 'web',
    "rawText" TEXT,
    "occurredAtTs" TIMESTAMPTZ(3) NOT NULL,
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL,
    "redactedAtTs" TIMESTAMPTZ(3),
    CONSTRAINT "CaptureEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CaptureTask" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "taskType" TEXT NOT NULL DEFAULT 'text_verbatim_candidate',
    "processorVersion" TEXT NOT NULL DEFAULT 'text-verbatim-v1',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "lastErrorCode" TEXT,
    "startedAtTs" TIMESTAMPTZ(3),
    "completedAtTs" TIMESTAMPTZ(3),
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL,
    "updatedAtTs" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "CaptureTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CaptureCandidate" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "candidateType" TEXT NOT NULL DEFAULT 'verbatim_note',
    "payload" JSONB,
    "reviewStatus" TEXT NOT NULL DEFAULT 'pending',
    "confidence" TEXT,
    "candidateVersion" TEXT NOT NULL DEFAULT 'text-verbatim-v1',
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL,
    "updatedAtTs" TIMESTAMPTZ(3) NOT NULL,
    "redactedAtTs" TIMESTAMPTZ(3),
    CONSTRAINT "CaptureCandidate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CaptureDeletionReceipt" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "lastErrorCode" TEXT,
    "claimToken" TEXT,
    "claimExpiresAtTs" TIMESTAMPTZ(3),
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL,
    "updatedAtTs" TIMESTAMPTZ(3) NOT NULL,
    "completedAtTs" TIMESTAMPTZ(3),
    CONSTRAINT "CaptureDeletionReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CaptureEvent_teacherId_clientRequestId_key" ON "CaptureEvent"("teacherId", "clientRequestId");
CREATE INDEX "CaptureEvent_teacherId_createdAtTs_idx" ON "CaptureEvent"("teacherId", "createdAtTs");
CREATE UNIQUE INDEX "CaptureTask_eventId_taskType_processorVersion_key" ON "CaptureTask"("eventId", "taskType", "processorVersion");
CREATE INDEX "CaptureTask_teacherId_status_idx" ON "CaptureTask"("teacherId", "status");
CREATE UNIQUE INDEX "CaptureCandidate_eventId_key" ON "CaptureCandidate"("eventId");
CREATE UNIQUE INDEX "CaptureCandidate_taskId_key" ON "CaptureCandidate"("taskId");
CREATE INDEX "CaptureCandidate_teacherId_reviewStatus_idx" ON "CaptureCandidate"("teacherId", "reviewStatus");
CREATE UNIQUE INDEX "CaptureDeletionReceipt_eventId_key" ON "CaptureDeletionReceipt"("eventId");
CREATE UNIQUE INDEX "CaptureDeletionReceipt_teacherId_clientRequestId_key" ON "CaptureDeletionReceipt"("teacherId", "clientRequestId");
CREATE INDEX "CaptureDeletionReceipt_teacherId_status_idx" ON "CaptureDeletionReceipt"("teacherId", "status");

ALTER TABLE "CaptureTask" ADD CONSTRAINT "CaptureTask_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "CaptureEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CaptureCandidate" ADD CONSTRAINT "CaptureCandidate_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "CaptureEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CaptureCandidate" ADD CONSTRAINT "CaptureCandidate_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "CaptureTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CaptureDeletionReceipt" ADD CONSTRAINT "CaptureDeletionReceipt_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "CaptureEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
