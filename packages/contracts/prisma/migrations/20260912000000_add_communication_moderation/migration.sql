ALTER TABLE "CommunicationDetail"
ADD COLUMN "moderationFlagged" BOOLEAN,
ADD COLUMN "moderationReasons" JSONB;
