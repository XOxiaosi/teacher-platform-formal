-- AlterTable
ALTER TABLE "FeedbackEvidence" ADD COLUMN     "mediaAssetId" TEXT;

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "sourceEntityType" TEXT,
    "sourceEntityId" TEXT,
    "sha256" TEXT NOT NULL,
    "duplicateOf" TEXT,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "privacyLevel" TEXT NOT NULL DEFAULT 'S1',
    "scanStatus" TEXT NOT NULL DEFAULT 'skipped',
    "originalPath" TEXT NOT NULL,
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MediaAsset_teacherId_idx" ON "MediaAsset"("teacherId");

-- CreateIndex
CREATE INDEX "MediaAsset_sha256_idx" ON "MediaAsset"("sha256");
