-- CreateTable
CREATE TABLE "ChannelMessage" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT,
    "channel" TEXT NOT NULL,
    "externalMessageId" TEXT NOT NULL,
    "fromExternalUserId" TEXT NOT NULL,
    "toExternalUserId" TEXT,
    "direction" TEXT NOT NULL DEFAULT 'inbound',
    "contentType" TEXT NOT NULL DEFAULT 'text',
    "contentText" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "processedAtTs" TIMESTAMPTZ(3),
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChannelMessage_channel_externalMessageId_key" ON "ChannelMessage"("channel", "externalMessageId");

-- CreateIndex
CREATE INDEX "ChannelMessage_teacherId_createdAtTs_idx" ON "ChannelMessage"("teacherId", "createdAtTs");
