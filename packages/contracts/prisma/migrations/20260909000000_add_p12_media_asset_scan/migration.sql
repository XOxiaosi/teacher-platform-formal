-- P12 平台预配线 A3/C（病毒扫描）：MediaAsset 增加扫描作业关联与威胁名（additive）。
-- scanJobId：最近一次扫描作业的内存 jobId（background-jobs 瞬态关联，DB scanStatus 为权威）；
-- scanThreatName：infected 时命中威胁名（ScanResponse.threatName，管理端可查看，人工复核依据）。
-- 纯 ALTER ADD COLUMN，无破坏性语句（D13/D41 additive 纪律）。
-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN     "scanJobId" TEXT,
ADD COLUMN     "scanThreatName" TEXT;
