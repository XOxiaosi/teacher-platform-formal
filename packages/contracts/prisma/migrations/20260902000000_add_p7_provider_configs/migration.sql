-- CreateTable
CREATE TABLE "ProviderConfig" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "providerKind" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "displayName" TEXT,
    "baseUrl" TEXT NOT NULL,
    "apiKeyEnc" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAtTs" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProviderConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderConfig_teacherId_isPrimary_idx" ON "ProviderConfig"("teacherId", "isPrimary");

-- CreateIndex
CREATE INDEX "ProviderConfig_teacherId_providerKind_idx" ON "ProviderConfig"("teacherId", "providerKind");

-- AddForeignKey
ALTER TABLE "ProviderConfig" ADD CONSTRAINT "ProviderConfig_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "TeacherRegistry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
