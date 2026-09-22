import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { err, internalError, notFound, ok, validationError, type CommonError, type Result } from '@teacher-platform/contracts';
import type { TeacherListItem } from './teacher-overview.js';

/**
 * 管理动作核心逻辑（P7 渠道线 A5，设计 §4）。
 *
 * - invitation：管理员只创建/撤销邀请，绝不代设教师密码；token 只返回一次，库内只存 hash。
 * - setTeacherStatus：软停用/启用；停用时事务内删除全部 session，恢复不恢复旧会话。
 * - isSafeRestoreTarget：演练恢复目标校验——**镜像 ops assertSafeRestoreDatabaseName**
 *   （RESTORE_DB_PATTERN 双形态 + 安全字符 + 禁系统库；防跨包 .mjs 导入的 tsc 类型限制，
 *   一致性由单测跨通道断言锁定：同反例集跑 ops 实现与本镜像断言一致——QA5 要求）。
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_INVITATION_TTL_HOURS = 72;
const MAX_INVITATION_TTL_HOURS = 168;

type InvitationPrisma = Pick<PrismaClient, 'teacherRegistry' | 'teacherInvitation' | '$queryRaw'>;
type StatusPrisma = Pick<PrismaClient, 'teacherRegistry' | 'sessionStore' | '$transaction'>;

export interface TeacherInvitationData {
  id: string;
  email: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAtTs: Date;
  createdAtTs: Date;
}

export interface CreateTeacherInvitationInput {
  email: string;
  expiresInHours?: number;
}

function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function databaseNow(prisma: Pick<PrismaClient, '$queryRaw'>): Promise<Date> {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
  const now = rows[0]?.now;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('数据库返回无效时间');
  return now;
}

function toInvitationData(record: {
  id: string;
  email: string;
  status: string;
  expiresAtTs: Date;
  createdAtTs: Date;
}, now: Date): TeacherInvitationData {
  const status = record.status === 'accepted'
    ? 'accepted'
    : record.status === 'revoked'
      ? 'revoked'
      : record.expiresAtTs.getTime() <= now.getTime()
        ? 'expired'
        : 'pending';
  return { id: record.id, email: record.email, status, expiresAtTs: record.expiresAtTs, createdAtTs: record.createdAtTs };
}

/** 创建邀请，明文 token 只在本次返回；管理员永远不接触教师密码。 */
export async function createTeacherInvitation(
  registryPrisma: InvitationPrisma,
  input: CreateTeacherInvitationInput,
): Promise<Result<{ invitation: TeacherInvitationData; token: string }, CommonError>> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) return err(validationError('邮箱格式不正确', 'email'));
  const hours = input.expiresInHours ?? DEFAULT_INVITATION_TTL_HOURS;
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_INVITATION_TTL_HOURS) {
    return err(validationError(`expiresInHours 必须是 1-${MAX_INVITATION_TTL_HOURS} 的整数`, 'expiresInHours'));
  }
  try {
    const now = await databaseNow(registryPrisma);
    const token = randomBytes(32).toString('base64url');
    const invitation = await registryPrisma.teacherInvitation.create({
      data: { email, tokenHash: hashInvitationToken(token), expiresAtTs: new Date(now.getTime() + hours * 60 * 60 * 1000) },
      select: { id: true, email: true, status: true, expiresAtTs: true, createdAtTs: true },
    });
    return ok({ invitation: toInvitationData(invitation, now), token });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(internalError(`创建邀请失败：${message}`));
  }
}

export async function listTeacherInvitations(
  registryPrisma: InvitationPrisma,
): Promise<Result<TeacherInvitationData[], CommonError>> {
  try {
    const now = await databaseNow(registryPrisma);
    const rows = await registryPrisma.teacherInvitation.findMany({
      select: { id: true, email: true, status: true, expiresAtTs: true, createdAtTs: true },
      orderBy: { createdAtTs: 'desc' },
    });
    return ok(rows.map((row) => toInvitationData(row, now)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(internalError(`读取邀请失败：${message}`));
  }
}

export async function revokeTeacherInvitation(
  registryPrisma: InvitationPrisma,
  invitationId: string,
): Promise<Result<TeacherInvitationData, CommonError>> {
  try {
    const now = await databaseNow(registryPrisma);
    const result = await registryPrisma.teacherInvitation.updateMany({
      where: { id: invitationId, status: 'pending' },
      data: { status: 'revoked', revokedAtTs: now },
    });
    if (result.count !== 1) return err(notFound('邀请不存在或不可撤销'));
    const invitation = await registryPrisma.teacherInvitation.findUnique({
      where: { id: invitationId },
      select: { id: true, email: true, status: true, expiresAtTs: true, createdAtTs: true },
    });
    if (!invitation) return err(notFound('邀请不存在'));
    return ok(toInvitationData(invitation, now));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(internalError(`撤销邀请失败：${message}`));
  }
}

export async function setTeacherStatus(
  registryPrisma: StatusPrisma,
  teacherId: string,
  status: 'active' | 'disabled',
): Promise<Result<TeacherListItem, CommonError>> {
  try {
    const updated = await registryPrisma.$transaction(async (tx) => {
      const teacher = await tx.teacherRegistry.findFirst({ where: { id: teacherId } });
      if (!teacher) return null;
      const item = await tx.teacherRegistry.update({
        where: { id: teacher.id },
        data: { status },
        select: {
          id: true,
          email: true,
          displayName: true,
          status: true,
          databaseName: true,
          createdAtTs: true,
          updatedAtTs: true,
        },
      });
      if (status === 'disabled') await tx.sessionStore.deleteMany({ where: { teacherId: teacher.id } });
      return item;
    });
    if (!updated) return err(notFound('教师不存在'));
    return ok(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err({ code: 'INTERNAL_ERROR', message: `更新教师状态失败：${message}` });
  }
}

// ---- 演练恢复目标校验（镜像 ops assertSafeRestoreDatabaseName，QA5 要求 1）----
// ops 实现：packages/ops/lib/db-safety.mjs RESTORE_DB_PATTERN + TEACHER_DB_NAME_PATTERN + SYSTEM_DB_NAMES。
// 本镜像与 ops 逐字段一致；跨通道一致性由 tests/functional/admin/admin-actions.test.ts
// 「反例集 ops↔镜像 双通道断言」锁定（teacher_platform / 无 _restore_ 教师库 / ../../evil 等）。

const RESTORE_DB_PATTERN = /^(teacher_db_[a-z0-9_]+_restore_[a-z0-9]+|teacher_platform_restore_[a-z0-9]+)$/;
const SAFE_NAME_PATTERN = /^[a-z0-9_]+$/;
const SYSTEM_DB_NAMES = new Set(['postgres', 'template0', 'template1', 'teacher_platform']);

export function isSafeRestoreTarget(databaseName: string): boolean {
  if (!RESTORE_DB_PATTERN.test(databaseName)) return false;
  if (!SAFE_NAME_PATTERN.test(databaseName)) return false;
  if (SYSTEM_DB_NAMES.has(databaseName)) return false;
  return true;
}

// ---- 演练恢复 dump 解析（restore 后台任务前置）----
// 从 BACKUP_ROOT/daily 最新 MANIFEST 中找该数据库的 dump 文件名（裸文件名，db-restore 在 daily/ 下解析）。

interface BackupManifestEntry {
  /** 库名（db-backup MANIFEST 条目字段：name/file） */
  name?: string;
  file?: string;
}

export async function resolveLatestDumpForDatabase(
  backupRoot: string,
  databaseName: string,
): Promise<string | null> {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join, resolve } = await import('node:path');
  try {
    const dailyDir = resolve(backupRoot, 'daily');
    const files = (await readdir(dailyDir)).filter((file) => /^MANIFEST-.*\.json$/.test(file)).sort();
    const latest = files[files.length - 1];
    if (!latest) return null;
    const raw = await readFile(join(dailyDir, latest), 'utf8');
    const manifest = JSON.parse(raw) as { databases?: BackupManifestEntry[] };
    const entry = (manifest.databases ?? []).find((item) => item.name === databaseName);
    return entry?.file ?? null;
  } catch {
    return null;
  }
}
