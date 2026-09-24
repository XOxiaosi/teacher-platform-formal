ALTER TABLE "ChannelConversation"
  ADD COLUMN "runtimeOwner" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "previousConversationId" TEXT;
