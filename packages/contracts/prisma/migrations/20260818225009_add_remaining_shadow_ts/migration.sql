-- AlterTable
ALTER TABLE "AINote" ADD COLUMN     "createdAtTs" TIMESTAMPTZ(3),
ADD COLUMN     "updatedAtTs" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "ChangeLog" ADD COLUMN     "createdAtTs" TIMESTAMPTZ(3),
ADD COLUMN     "timestampTs" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "createdAtTs" TIMESTAMPTZ(3),
ADD COLUMN     "updatedAtTs" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "ConversationTurn" ADD COLUMN     "createdAtTs" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "DailyReview" ADD COLUMN     "createdAtTs" TIMESTAMPTZ(3),
ADD COLUMN     "dateTs" DATE,
ADD COLUMN     "updatedAtTs" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Lesson" ADD COLUMN     "createdAtTs" TIMESTAMPTZ(3),
ADD COLUMN     "dateTs" TIMESTAMPTZ(3),
ADD COLUMN     "updatedAtTs" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Memo" ADD COLUMN     "createdAtTs" TIMESTAMPTZ(3),
ADD COLUMN     "dueAtTs" TIMESTAMPTZ(3),
ADD COLUMN     "updatedAtTs" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "ParentFeedback" ADD COLUMN     "createdAtTs" TIMESTAMPTZ(3),
ADD COLUMN     "sentAtTs" TIMESTAMPTZ(3),
ADD COLUMN     "updatedAtTs" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "createdAtTs" TIMESTAMPTZ(3),
ADD COLUMN     "paidAtTs" TIMESTAMPTZ(3),
ADD COLUMN     "updatedAtTs" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "PendingAction" ADD COLUMN     "cancelledAtTs" TIMESTAMPTZ(3),
ADD COLUMN     "consumedAtTs" TIMESTAMPTZ(3),
ADD COLUMN     "createdAtTs" TIMESTAMPTZ(3),
ADD COLUMN     "expiresAtTs" TIMESTAMPTZ(3),
ADD COLUMN     "updatedAtTs" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "PushRecord" ADD COLUMN     "createdAtTs" TIMESTAMPTZ(3),
ADD COLUMN     "scheduledAtTs" TIMESTAMPTZ(3),
ADD COLUMN     "sentAtTs" TIMESTAMPTZ(3),
ADD COLUMN     "updatedAtTs" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Schedule" ADD COLUMN     "createdAtTs" TIMESTAMPTZ(3),
ADD COLUMN     "scheduledEndTs" TIMESTAMPTZ(3),
ADD COLUMN     "scheduledStartTs" TIMESTAMPTZ(3),
ADD COLUMN     "updatedAtTs" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Student" ADD COLUMN     "createdAtTs" TIMESTAMPTZ(3),
ADD COLUMN     "updatedAtTs" TIMESTAMPTZ(3);
