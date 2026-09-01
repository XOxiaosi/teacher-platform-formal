-- P14 D 切片（moderation 接线 UserRequirement）：additive 审核标记列。
-- moderationFlagged：本地规则命中标记（review 心智——不阻断写库，人工复核依据）；
-- moderationReasons：命中原因（规则组 id + 中文描述数组，jsonb；未命中/未配置 null）。
-- 纯 ALTER ADD COLUMN，无破坏性语句（D13/D41 additive 纪律）。
-- AlterTable
ALTER TABLE "UserRequirement" ADD COLUMN     "moderationFlagged" BOOLEAN,
ADD COLUMN     "moderationReasons" JSONB;
