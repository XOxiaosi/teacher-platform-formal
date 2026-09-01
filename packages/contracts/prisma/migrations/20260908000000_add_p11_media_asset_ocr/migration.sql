-- P11 平台预配线 A2（OCR/MediaAnalysis）：MediaAsset 增加 OCR 状态/文本/版面块/作业关联（additive）。
-- ocrStatus：图片 OCR 状态占位流转（none|pending|completed|failed；阶段三-B 真实 OCR 驱动）；
-- ocrText：OCR 识别文本（P11 A2 占位；阶段三-B 真实 OCR 结果写入）；
-- ocrLayoutBlocks：MediaAnalysis.layoutBlocks 输入（{ text, bbox }[]，jsonb，区域证据 D40 §5.5）；
-- ocrJobId：最近一次 OCR 作业的内存 jobId（background-jobs 瞬态关联，DB 状态为权威）。

-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN     "ocrStatus" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "ocrText" TEXT,
ADD COLUMN     "ocrLayoutBlocks" JSONB,
ADD COLUMN     "ocrJobId" TEXT;
