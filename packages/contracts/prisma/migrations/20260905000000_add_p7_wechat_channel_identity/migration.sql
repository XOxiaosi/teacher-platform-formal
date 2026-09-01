-- CreateTable
CREATE TABLE "ChannelIdentity" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "providerChannelId" TEXT,
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAtTs" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ChannelIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChannelIdentity_platform_externalUserId_key" ON "ChannelIdentity"("platform", "externalUserId");

-- CreateIndex
CREATE INDEX "ChannelIdentity_teacherId_idx" ON "ChannelIdentity"("teacherId");

-- AddForeignKey
ALTER TABLE "ChannelIdentity" ADD CONSTRAINT "ChannelIdentity_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "TeacherRegistry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
