import type { PrismaClient } from '@prisma/client';
import {
  err,
  internalError,
  ok,
  validationError,
  type CommonError,
  type Result,
} from '@teacher-platform/contracts';
import type { ChannelIdentityDto, ChannelIdentityService } from './types.js';

/**
 * 渠道身份服务（设计 p7-wechat-ilink-design.md §3/§8.2；共享库表 ChannelIdentity）。
 *
 * - 一微信号（externalUserId）至多绑定一个教师：@@unique([platform, externalUserId])；
 * - 一个教师至多一个绑定（应用层校验，先解绑再绑）；
 * - 解绑 = 删除行（unbind 幂等）；
 * - resolveTeacherId 供 S2 消息渠道复用：解析 teacherId → runAsTeacher + databaseRouter
 *   （不另立渠道 token；认证事实仍来自现有 session/scrypt 体系）。
 */

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === 'P2002'
  );
}

function toDto(row: {
  id: string;
  teacherId: string;
  platform: string;
  externalUserId: string;
  providerChannelId: string | null;
  createdAtTs: Date;
  updatedAtTs: Date;
}): ChannelIdentityDto {
  return {
    id: row.id,
    teacherId: row.teacherId,
    platform: row.platform,
    externalUserId: row.externalUserId,
    providerChannelId: row.providerChannelId,
    createdAtTs: row.createdAtTs,
    updatedAtTs: row.updatedAtTs,
  };
}

export function createChannelIdentityService(options: { prisma: PrismaClient }): ChannelIdentityService {
  const { prisma } = options;

  async function bind(input: {
    teacherId: string;
    platform: string;
    externalUserId: string;
    providerChannelId?: string;
  }): Promise<Result<ChannelIdentityDto, CommonError>> {
    if (!input.teacherId.trim()) return err(validationError('教师 ID 不能为空', 'teacherId'));
    if (!input.platform.trim()) return err(validationError('渠道平台不能为空', 'platform'));
    if (!input.externalUserId.trim()) return err(validationError('微信用户标识不能为空', 'externalUserId'));

    // 一微信号一 Agent：externalUserId 已绑定 → 同教师幂等返回；异教师拒绝
    const existing = await prisma.channelIdentity.findUnique({
      where: {
        platform_externalUserId: { platform: input.platform, externalUserId: input.externalUserId },
      },
    });
    if (existing) {
      if (existing.teacherId === input.teacherId) return ok(toDto(existing)); // 回调重试幂等
      return err(validationError('该微信账号已绑定其他教师', 'externalUserId'));
    }

    // 教师已绑定 → 必须先解绑（解绑=删除行）
    const teacherBinding = await prisma.channelIdentity.findFirst({
      where: { teacherId: input.teacherId, platform: input.platform },
    });
    if (teacherBinding) {
      return err(validationError('该教师已绑定微信，请先解绑', 'teacherId'));
    }

    try {
      const created = await prisma.channelIdentity.create({
        data: {
          teacherId: input.teacherId,
          platform: input.platform,
          externalUserId: input.externalUserId,
          ...(input.providerChannelId ? { providerChannelId: input.providerChannelId } : {}),
        },
      });
      return ok(toDto(created));
    } catch (error) {
      if (isUniqueViolation(error)) {
        return err(validationError('该微信账号已绑定其他教师', 'externalUserId'));
      }
      const message = error instanceof Error ? error.message : String(error);
      return err(internalError(`微信绑定失败：${message}`));
    }
  }

  async function unbind(input: {
    teacherId: string;
    platform: string;
  }): Promise<Result<{ unbound: boolean }, CommonError>> {
    const result = await prisma.channelIdentity.deleteMany({
      where: { teacherId: input.teacherId, platform: input.platform },
    });
    return ok({ unbound: result.count > 0 });
  }

  async function resolveTeacherId(input: {
    platform: string;
    externalUserId: string;
  }): Promise<Result<string | null, CommonError>> {
    const row = await prisma.channelIdentity.findUnique({
      where: {
        platform_externalUserId: { platform: input.platform, externalUserId: input.externalUserId },
      },
      select: { teacherId: true },
    });
    return ok(row ? row.teacherId : null);
  }

  async function resolveChannelBinding(input: {
    platform: string;
    externalUserId: string;
  }): Promise<Result<{ teacherId: string; providerChannelId: string | null } | null, CommonError>> {
    const row = await prisma.channelIdentity.findUnique({
      where: {
        platform_externalUserId: { platform: input.platform, externalUserId: input.externalUserId },
      },
      select: { teacherId: true, providerChannelId: true },
    });
    return ok(row ? { teacherId: row.teacherId, providerChannelId: row.providerChannelId } : null);
  }

  async function listByTeacher(input: {
    teacherId: string;
    platform?: string;
  }): Promise<Result<ChannelIdentityDto[], CommonError>> {
    const rows = await prisma.channelIdentity.findMany({
      where: { teacherId: input.teacherId, ...(input.platform ? { platform: input.platform } : {}) },
      orderBy: { createdAtTs: 'asc' },
    });
    return ok(rows.map(toDto));
  }

  return { bind, unbind, resolveTeacherId, resolveChannelBinding, listByTeacher };
}
