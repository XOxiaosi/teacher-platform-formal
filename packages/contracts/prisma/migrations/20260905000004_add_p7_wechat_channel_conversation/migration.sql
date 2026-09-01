-- CreateTable
CREATE TABLE "ChannelConversation" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "externalConversationId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastMessageAtTs" TIMESTAMPTZ(3),
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAtTs" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ChannelConversation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChannelConversation_channel_teacherId_externalConversationId_key" ON "ChannelConversation"("channel", "teacherId", "externalConversationId");

-- CreateIndex
CREATE INDEX "ChannelConversation_teacherId_status_idx" ON "ChannelConversation"("teacherId", "status");
