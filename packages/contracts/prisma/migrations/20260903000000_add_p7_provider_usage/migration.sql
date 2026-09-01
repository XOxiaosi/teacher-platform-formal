-- CreateTable
CREATE TABLE "ProviderUsage" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "providerConfigId" TEXT,
    "providerName" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" DOUBLE PRECISION,
    "conversationId" TEXT,
    "requestAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderUsage_teacherId_requestAt_idx" ON "ProviderUsage"("teacherId", "requestAt");

-- CreateIndex
CREATE INDEX "ProviderUsage_providerConfigId_idx" ON "ProviderUsage"("providerConfigId");

-- AddForeignKey
ALTER TABLE "ProviderUsage" ADD CONSTRAINT "ProviderUsage_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "TeacherRegistry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
