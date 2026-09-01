-- D51 ParentFeedback 出站本地审核：additive 审核投影列。
-- moderationFlagged：NULL=未检查/失败/未配置，FALSE=本地检查通过，TRUE=命中人工复核；
-- moderationReasons：本地审核原因数组（jsonb），未检查/失败/未配置为 NULL。
-- 纯 ALTER ADD COLUMN；迁移仅入库，不在本任务中手工执行。
-- AlterTable
ALTER TABLE "ParentFeedback" ADD COLUMN     "moderationFlagged" BOOLEAN,
ADD COLUMN     "moderationReasons" JSONB;
