/**
 * 测试专用邀请构造器。
 *
 * 只位于 tests/ 下，生产代码绝不导出/装配等价的免邀请注册入口。它直接写入 tokenHash，
 * 让跨域测试能获得真实会话而不重新开放 /auth/register。
 */
import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import request from 'supertest';

export interface SeedInvitationInput {
  email: string;
  expiresAtTs?: Date;
  status?: 'pending' | 'accepted' | 'revoked';
}

export async function seedInvitation(
  prisma: Pick<PrismaClient, 'teacherInvitation'>,
  input: SeedInvitationInput,
): Promise<{ id: string; token: string; email: string }> {
  const token = randomBytes(32).toString('base64url');
  const invitation = await prisma.teacherInvitation.create({
    data: {
      email: input.email.trim().toLowerCase(),
      tokenHash: createHash('sha256').update(token).digest('hex'),
      status: input.status ?? 'pending',
      // 使用远期固定时刻，测试不依赖运行机器的当前时间。
      expiresAtTs: input.expiresAtTs ?? new Date('2099-01-01T00:00:00.000Z'),
    },
    select: { id: true, email: true },
  });
  return { ...invitation, token };
}

export async function acceptInvitation(
  app: Express,
  prisma: Pick<PrismaClient, 'teacherInvitation'>,
  input: { email: string; password?: string; displayName?: string },
  agent?: request.SuperAgentTest,
) {
  const invitation = await seedInvitation(prisma, { email: input.email });
  const response = await (agent ?? request(app))
    .post('/api/v1/auth/invitations/accept')
    .send({ token: invitation.token, password: input.password ?? 'password123', displayName: input.displayName ?? '测试老师' });
  return { invitation, response };
}
