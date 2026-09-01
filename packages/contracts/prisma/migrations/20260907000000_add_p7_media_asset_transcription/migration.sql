-- P9 S3 阶段二续（t6）：MediaAsset 增加转写结果文本 + 转写作业关联（additive）。
-- transcriptionText：转写结果文本（占位；阶段三真实 ASR 结果写入）；
-- transcriptionJobId：最近一次转写作业的内存 jobId（background-jobs 瞬态关联，DB 状态为权威）。

-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN     "transcriptionText" TEXT,
ADD COLUMN     "transcriptionJobId" TEXT;
