-- P9 S3 阶段二（t3）：MediaAsset 增加文件加密/转写状态/孤儿回收字段（additive）。
-- encryptionVersion：'aes-256-gcm' | null（null=阶段一明文遗留，读路径双读直通）；
-- transcriptionStatus：ASR 转写状态占位流转（阶段三真实 ASR 接入）；
-- orphanStatus/orphanMarkedAtTs：孤儿回收标记（引用保护 + 保留期后清理，p7-media-evidence-design.md §6.2）。

-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN     "transcriptionStatus" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "encryptionVersion" TEXT,
ADD COLUMN     "orphanStatus" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "orphanMarkedAtTs" TIMESTAMPTZ(3);

-- CreateIndex（孤儿回收扫描：orphan 状态 + 标记时间）
CREATE INDEX "MediaAsset_orphanStatus_orphanMarkedAtTs_idx" ON "MediaAsset"("orphanStatus", "orphanMarkedAtTs");
