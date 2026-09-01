import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/index.js';
import { createLogger } from '../../src/shared/logger/index.js';

/**
 * P14 D 切片（moderation 接线 UserRequirement，t2）HTTP 全链路测试：
 * composition 注入 createPlatformServices(env).moderation（本地规则先行）——
 * 含敏感词 POST /requirements → 201（不阻断）+ 审计日志含 reasons；
 * 正常文本 → 无 flag；未配置 moderation → 零影响（基线）。
 */

const prisma = new PrismaClient();
const createdIds: string[] = [];
const createdTeacherIds: string[] = [];

// 本文件进程级 env：moderation 装配开关（vitest 按文件隔离 worker，不影响其他测试文件）
const ENV_ENABLED = 'PLATFORM_SERVICES_ENABLED';
const ENV_MODERATION = 'PLATFORM_MODERATION_PROVIDER';

function createCapturingLogger(lines: string[]) {
  return createLogger({ write: (line) => lines.push(line) });
}

let moderatedLines: string[] = [];
let baselineLines: string[] = [];

// 基线 app：moderation 未配置（默认 env，零影响）——先于 env 修改创建
const baselineApp = createApp(prisma, { logger: createCapturingLogger(baselineLines) });

// moderation 装配 app：PLATFORM_SERVICES_ENABLED=true + PLATFORM_MODERATION_PROVIDER=local
process.env[ENV_ENABLED] = 'true';
process.env[ENV_MODERATION] = 'local';
// 本文件验证显式启用供应商装配的历史契约；默认 local-safe 关闭路径另有 L0 组合测试锁定。
const moderatedApp = createApp(prisma, {
  logger: createCapturingLogger(moderatedLines),
  localSafeMode: false,
});

async function ensureTeacher(id: string): Promise<void> {
  const existing = await prisma.teacherRegistry.findUnique({ where: { id } });
  if (existing) return;
  await prisma.teacherRegistry.create({
    data: { id, email: `${id}@example.com`, passwordHash: 'test-hash', displayName: id },
  });
  createdTeacherIds.push(id);
}

function uniqueQuote(prefix = 'req-mod-e2e'): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

beforeAll(async () => {
  await ensureTeacher('req-mod-e2e-teacher');
});

beforeEach(() => {
  // 每个用例独立捕获窗口（避免跨用例 flag 行污染断言）——原地清空（logger 闭包持有原数组引用）
  moderatedLines.length = 0;
  baselineLines.length = 0;
});

afterAll(async () => {
  delete process.env[ENV_ENABLED];
  delete process.env[ENV_MODERATION];
  await prisma.userRequirement.deleteMany({ where: { id: { in: createdIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: createdTeacherIds } } });
  await prisma.$disconnect();
});

describe('POST /requirements + moderation 接线（P14 D 切片 · t2）', () => {
  it('含敏感词提交 → 201（不阻断写库）+ 审计日志 msg=moderation flag 含 reasons', async () => {
    const quote = uniqueQuote();
    const res = await request(moderatedApp)
      .post('/api/v1/requirements')
      .set('x-teacher-id', 'req-mod-e2e-teacher')
      .send({ verbatimQuote: `打死你这个骗子 ${quote}`, category: 'feature' });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    const id = res.body.data.id;
    createdIds.push(id);

    // 审计日志：moderation flag + reasons（violence 组）
    const auditLine = moderatedLines.find((l) => l.includes('"msg":"moderation flag"'));
    expect(auditLine).toBeDefined();
    const audit = JSON.parse(auditLine!) as Record<string, unknown>;
    expect(audit.actor).toBe('req-mod-e2e-teacher');
    expect(audit.requirementId).toBe(id);
    expect(Array.isArray(audit.reasons)).toBe(true);
    expect((audit.reasons as string[]).some((r) => r.startsWith('violence'))).toBe(true);
  });

  it('正常文本 → 201 + 无 moderation flag 审计日志', async () => {
    const res = await request(moderatedApp)
      .post('/api/v1/requirements')
      .set('x-teacher-id', 'req-mod-e2e-teacher')
      .send({ verbatimQuote: `今天的作业是完成第三单元练习 ${uniqueQuote()}`, category: 'improvement' });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    createdIds.push(res.body.data.id);
    expect(moderatedLines.some((l) => l.includes('"msg":"moderation flag"'))).toBe(false);
  });

  it('未配置 moderation → 零影响（基线）：201 + 无审计日志', async () => {
    const res = await request(baselineApp)
      .post('/api/v1/requirements')
      .set('x-teacher-id', 'req-mod-e2e-teacher')
      .send({ verbatimQuote: `打死你这个骗子 ${uniqueQuote()}`, category: 'feature' });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    createdIds.push(res.body.data.id);
    expect(baselineLines.some((l) => l.includes('"msg":"moderation flag"'))).toBe(false);
  });
});
