/**
 * 媒体孤儿回收器（P9 S3 阶段二 · t3，设计 p7-media-evidence-design.md §6.2 引用完整性）。
 *
 * 语义：
 * - 孤儿 = MediaAsset 未被任何引用锚点指向：
 *   · StudentSourceRecord（sourceEntityType='MediaAsset' && sourceEntityId=asset.id）——捕获证据链；
 *   · FeedbackEvidence.mediaAssetId——对外快照引用（快照只引用不复制文件本体）。
 * - 两阶段回收：
 *   1) markOrphans：未被引用的资产 → orphanStatus='orphan'，orphanMarkedAtTs=TrustedClock 此刻
 *      （进入保留期窗口；被引用资产/已被引用的 orphan 资产回滚为 active——保护恢复）；
 *   2) cleanupExpired：orphan 且标记时间超出保留期（默认 30 天，设计 §6.2）→ 物理删除文件 + 行
 *      （删除前重查引用，防止标记后被引用的资产被误删——快照引用保护不变式）。
 *
 * 纪律：
 * - orphanMarkedAtTs 一律走 TrustedClock（DB CURRENT_TIMESTAMP），不引入未登记 new Date；
 * - 文件删除失败 → 保留行（可重试）；行删除在文件删除成功之后；
 * - 分批扫描（batchSize 上限），单批失败不中断整轮（错误计数返回，由调用方决定重试策略）。
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import { ok, type CommonError, type Result } from '@teacher-platform/contracts';
import { createDatabaseTrustedClock, type TrustedClock } from '../../shared/trusted-clock/index.js';
import type { StorageService } from '../../shared/storage/types.js';

type OrphanPrismaClient = PrismaClient | Prisma.TransactionClient;

export const DEFAULT_ORPHAN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 天（设计 §6.2）
const DEFAULT_BATCH_SIZE = 50;

export interface CreateMediaOrphanReaperOptions {
  getClient: () => Promise<OrphanPrismaClient>;
  storage: StorageService;
  /** 注入可信时钟（默认 DB TrustedClock；测试可注入假时钟）。 */
  trustedClock?: TrustedClock;
  /** orphan 保留期：标记后超过该时长才物理清理（默认 30 天）。 */
  retentionMs?: number;
  /** 每轮扫描批次上限（默认 50）。 */
  batchSize?: number;
}

export interface MediaOrphanReaper {
  /** 阶段一：扫描未被引用的资产 → 标记 orphan；被引用（含已标记后新引用）→ 恢复 active。 */
  markOrphans(): Promise<Result<{ marked: number; restored: number }, CommonError>>;
  /** 阶段二：orphan 且超保留期 → 重查引用后物理删除文件 + 行。 */
  cleanupExpired(): Promise<Result<{ deleted: number; errors: number }, CommonError>>;
  /** 一轮完整回收：markOrphans + cleanupExpired（定时任务用）。 */
  runOnce(): Promise<Result<{ marked: number; restored: number; deleted: number; errors: number }, CommonError>>;
}

/**
 * 资产是否被引用（引用锚点：StudentSourceRecord 捕获链 / FeedbackEvidence 快照引用）。
 * 按 teacherId 收窄（引用与资产同教师；防跨教师伪造引用锚点）。
 */
async function isReferenced(
  prisma: OrphanPrismaClient,
  teacherId: string,
  assetId: string,
): Promise<boolean> {
  const [sourceCount, evidenceCount] = await Promise.all([
    prisma.studentSourceRecord.count({
      where: { teacherId, sourceEntityType: 'MediaAsset', sourceEntityId: assetId },
    }),
    prisma.feedbackEvidence.count({
      where: { teacherId, mediaAssetId: assetId },
    }),
  ]);
  return sourceCount > 0 || evidenceCount > 0;
}

export function createMediaOrphanReaper(options: CreateMediaOrphanReaperOptions): MediaOrphanReaper {
  const { storage } = options;
  const retentionMs = options.retentionMs ?? DEFAULT_ORPHAN_RETENTION_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  async function resolve(): Promise<{
    prisma: OrphanPrismaClient;
    trustedClock: TrustedClock;
  }> {
    const prisma = await options.getClient();
    const trustedClock = options.trustedClock ?? createDatabaseTrustedClock(prisma);
    return { prisma, trustedClock };
  }

  async function markOrphans(): Promise<Result<{ marked: number; restored: number }, CommonError>> {
    const { prisma, trustedClock } = await resolve();
    const now = await trustedClock.now();
    if (!now.ok) return now;

    let marked = 0;
    let restored = 0;
    let cursor = 0;
    for (;;) {
      // 分批：active（未标记）与 orphan（保护恢复）两族分别处理
      const batch = await prisma.mediaAsset.findMany({
        where: { OR: [{ orphanStatus: 'active' }, { orphanStatus: 'orphan' }] },
        orderBy: { id: 'asc' },
        skip: cursor,
        take: batchSize,
        select: { id: true, teacherId: true, orphanStatus: true },
      });
      if (batch.length === 0) break;
      cursor += batch.length;

      for (const asset of batch) {
        const referenced = await isReferenced(prisma, asset.teacherId, asset.id);
        if (referenced && asset.orphanStatus === 'orphan') {
          // 保护恢复：标记后新出现引用（如稍后 captureEvidence）→ 回到 active，保留期作废
          await prisma.mediaAsset.update({
            where: { id: asset.id },
            data: { orphanStatus: 'active', orphanMarkedAtTs: null },
          });
          restored += 1;
        } else if (!referenced && asset.orphanStatus === 'active') {
          await prisma.mediaAsset.update({
            where: { id: asset.id },
            data: { orphanStatus: 'orphan', orphanMarkedAtTs: now.value },
          });
          marked += 1;
        }
      }
      if (batch.length < batchSize) break;
    }
    return ok({ marked, restored });
  }

  async function cleanupExpired(): Promise<Result<{ deleted: number; errors: number }, CommonError>> {
    const { prisma, trustedClock } = await resolve();
    const now = await trustedClock.now();
    if (!now.ok) return now;
    // 保留期截止线 = 可信当前时刻 - 保留期（时间来源仍为 TrustedClock）
    const cutoff = new Date(now.value.getTime() - retentionMs);

    let deleted = 0;
    let errors = 0;
    let lastId: string | undefined;
    for (;;) {
      // 游标分页（id 升序）：清理会删除行，skip 分页窗口会漂移漏扫，游标稳定
      const batch = await prisma.mediaAsset.findMany({
        where: {
          orphanStatus: 'orphan',
          orphanMarkedAtTs: { lte: cutoff },
          ...(lastId ? { id: { gt: lastId } } : {}),
        },
        orderBy: { id: 'asc' },
        take: batchSize,
      });
      if (batch.length === 0) break;

      for (const asset of batch) {
        // 删除前重查引用：标记后可能已被引用（快照引用保护不变式）——引用则跳过，保留期顺延
        const referenced = await isReferenced(prisma, asset.teacherId, asset.id);
        if (referenced) {
          await prisma.mediaAsset.update({
            where: { id: asset.id },
            data: { orphanStatus: 'active', orphanMarkedAtTs: null },
          });
          lastId = asset.id;
          continue;
        }
        // 先物理删文件，成功后才删行（失败保留行可重试，避免「行没了文件还在」泄漏）
        const removed = await storage.delete({ fileRef: asset.originalPath });
        if (!removed.ok) {
          errors += 1;
          lastId = asset.id;
          continue;
        }
        await prisma.mediaAsset.delete({ where: { id: asset.id } });
        deleted += 1;
      }
      if (batch.length < batchSize) break;
    }
    return ok({ deleted, errors });
  }

  return {
    markOrphans,
    cleanupExpired,
    async runOnce() {
      const markedRes = await markOrphans();
      if (!markedRes.ok) return markedRes;
      const cleanupRes = await cleanupExpired();
      if (!cleanupRes.ok) return cleanupRes;
      return ok({
        marked: markedRes.value.marked,
        restored: markedRes.value.restored,
        deleted: cleanupRes.value.deleted,
        errors: cleanupRes.value.errors,
      });
    },
  };
}
