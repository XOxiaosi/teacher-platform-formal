-- AlterTable
ALTER TABLE "AgentExecution" ADD COLUMN     "createdAtTs" TIMESTAMPTZ(3),
ADD COLUMN     "finishedAtTs" TIMESTAMPTZ(3),
ADD COLUMN     "startedAtTs" TIMESTAMPTZ(3),
ADD COLUMN     "updatedAtTs" TIMESTAMPTZ(3);
