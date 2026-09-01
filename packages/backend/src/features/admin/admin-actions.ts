import type { PrismaClient } from '@prisma/client';
import { alreadyConsumed, err, internalError, notFound, ok, validationError, type CommonError, type Result } from '@teacher-platform/contracts';
import { hashAdminPassword } from './admin-auth-service.js';
import type { TeacherListItem } from './teacher-overview.js';

/**
 * 管理动作核心逻辑（P7 渠道线 A5，设计 §4）。
 *
 * - createTeacher：与教师 register 同能力（email 唯一 + scrypt 哈希，hashAdminPassword 同算法/格式）；
 *   重复 email → ALREADY_CONSUMED（409）。
 * - setTeacherStatus：软停用/启用（仅 registry status 翻转，**不是** deactivate-teacher 注销删除；
 *   停用后登录立即 401 由 auth-service status 检查锁定，A3 测试已覆盖）。
 * - isSafeRestoreTarget：演练恢复目标校验——**镜像 ops assertSafeRestoreDatabaseName**
 *   （RESTORE_DB_PATTERN 双形态 + 安全字符 + 禁系统库；防跨包 .mjs 导入的 tsc 类型限制，
 *   一致性由单测跨通道断言锁定：同反例集跑 ops 实现与本镜像断言一致——QA5 要求）。
 */

const MIN_PASSWORD_LENGTH = 8;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_DATABASE_NAME = 'teacher_platform';

export interface CreateTeacherInput {
  email: string;
  password: string;
  displayName: string;
  /** 缺省共享库 teacher_platform；provision 时由路由生成 teacher_db_* 安全名 */
  databaseName?: string;
}

export async function createTeacher(
  registryPrisma: Pick<PrismaClient, 'teacherRegistry'>,
  input: CreateTeacherInput,
): Promise<Result<TeacherListItem, CommonError>> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    return err(validationError('邮箱格式不正确', 'email'));
  }
  if (typeof input.password !== 'string' || input.password.length < MIN_PASSWORD_LENGTH) {
    return err(validationError(`密码长度至少 ${MIN_PASSWORD_LENGTH} 位`, 'password'));
  }
  if (!input.displayName || input.displayName.trim() === '') {
    return err(validationError('昵称不能为空', 'displayName'));
  }
  try {
    const teacher = await registryPrisma.teacherRegistry.create({
      data: {
        email,
        passwordHash: hashAdminPassword(input.password),
        displayName: input.displayName.trim(),
        databaseName: input.databaseName ?? DEFAULT_DATABASE_NAME,
      },
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
    return ok(teacher);
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002') {
      return err(alreadyConsumed('该邮箱已注册'));
    }
    const message = error instanceof Error ? error.message : String(error);
    return err(internalError(`创建教师失败：${message}`));
  }
}

export async function setTeacherStatus(
  registryPrisma: Pick<PrismaClient, 'teacherRegistry'>,
  teacherId: string,
  status: 'active' | 'disabled',
): Promise<Result<TeacherListItem, CommonError>> {
  try {
    const teacher = await registryPrisma.teacherRegistry.findFirst({ where: { id: teacherId } });
    if (!teacher) return err(notFound('教师不存在'));
    const updated = await registryPrisma.teacherRegistry.update({
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
