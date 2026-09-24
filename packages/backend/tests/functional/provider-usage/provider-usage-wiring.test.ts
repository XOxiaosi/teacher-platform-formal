/**
 * P16 P1 修复（t69 装配遗漏）：ProviderUsage 采集接线测试。
 *
 * 背景：qa3 全链路 smoke 发现 /usage/summary 与 admin 用量看板恒 0——
 * core-route-dependencies.ts 的正式结构化输入路径必须把模型用量写入
 * ProviderUsage；DSH 自己的用量由 TeachingRuntimeUsage 记录，不再构造第二套旧 Agent client。
 *
 * 本测试验证真实链路（本地 mock OpenAI 兼容服务 + 真实 routing client + 真实 record）：
 * 1. 装配 createCoreRouteDependencies(prisma)（生产同款组合）；
 * 2. 教师注册 + 配置 mock provider（baseUrl 指向本地 mock 服务，apiKey 加密落库）；
 * 3. runAsTeacher 模拟请求级教师身份（生产 dbRouter 分支由中间件注入，语义一致）；
 * 4. 路径 A：saveRawInput → aiNotes.parseInput → aiClient.run ×2（第一处 createRoutingAiClient）
 *    → ProviderUsage 落 2 行；
 * 5. 断言：ProviderUsage 2 行（tokens 全 >0）+ summary 非 0，且正式组合不再暴露旧 Agent。
 */

import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createCoreRouteDependencies } from '../../../src/app/composition/core-route-dependencies.js';
import { runAsTeacher } from '../../../src/shared/ai-client/index.js';

// ProviderConfig apiKey 加密/解密需要该 env（llm-line-workflow.test.ts 同款模式）；测试后清理
process.env.PROVIDER_KEY_ENCRYPTION_KEY = 'd'.repeat(64);
// SSRF 守卫白名单：本测试把 ProviderConfig.baseUrl 指向本地 mock（127.0.0.1）——
// 走真实生产机制（PROVIDER_BASEURL_ALLOWED_IPS CIDR 放行），不 bypass 守卫
process.env.PROVIDER_BASEURL_ALLOWED_IPS = '127.0.0.0/8';

const prisma = new PrismaClient();
// 此测试验证正式 provider 路径；local-safe 默认关闭 provider 装配，故显式 opt-out。
const deps = createCoreRouteDependencies(prisma, { localSafeMode: false });

let mockServer: http.Server;
let mockPort = 0;
let runCalls = 0;

const createdTeacherIds: string[] = [];

function unique(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

beforeAll(async () => {
  // 本地 OpenAI 兼容 mock：POST /chat/completions —— 请求体含 tools 数组 → chat 形态；
  // 否则 → run 形态（content 必须是可 JSON.parse 的结构化结果）。
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let parsed: { tools?: unknown } = {};
      try {
        parsed = JSON.parse(body) as { tools?: unknown };
      } catch {
        // 非 JSON 请求体 → 按 run 形态处理
      }
      const isChat = Array.isArray(parsed.tools);
      if (!isChat) runCalls += 1;
      const content = isChat
        ? '好的，已处理'
        : JSON.stringify({ intent: 'lesson', confidenceScore: 0.9, studentName: '小明' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content } }],
        usage: { prompt_tokens: isChat ? 30 : 25, completion_tokens: isChat ? 8 : 7 },
      }));
    });
  });
  await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve()));
  const address = mockServer.address();
  if (address && typeof address === 'object') {
    mockPort = address.port;
  }
});

afterAll(async () => {
  await prisma.providerUsage.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.providerConfig.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.aINote.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.sessionStore.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: createdTeacherIds } } });
  await prisma.$disconnect();
  delete process.env.PROVIDER_KEY_ENCRYPTION_KEY;
  delete process.env.PROVIDER_BASEURL_ALLOWED_IPS;
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
});

describe('ProviderUsage 采集接线（P16 P1：正式结构化输入 onUsage → record）', () => {
  it('真实链路：mock provider → run×2 → ProviderUsage 落 2 行，且不装配旧 Agent', async () => {
    const teacherId = unique('usage-wiring');
    await prisma.teacherRegistry.create({
      data: {
        id: teacherId,
        email: `${teacherId}@example.com`,
        passwordHash: 'unused-hash',
        displayName: '用量接线测试',
      },
    });
    createdTeacherIds.push(teacherId);

    // 配置 mock provider（本地 OpenAI 兼容；首条自动 isPrimary + status=active）
    const created = await deps.providerConfig!.providerConfigService.create(teacherId, {
      providerKind: 'openai',
      providerName: 'mock-vendor',
      baseUrl: `http://127.0.0.1:${mockPort}`,
      apiKey: 'sk-mock-key',
      model: 'mock-model',
    });
    expect(created.ok).toBe(true);
    const configId = created.ok ? created.value.id : '';

    // 修复前状态：usage 恒 0（无任何采集点）
    const beforeRows = await prisma.providerUsage.count({ where: { teacherId } });
    expect(beforeRows).toBe(0);

    // 路径 A：第一处 createRoutingAiClient（aiNotes/saveRawInput）——run() ×2
    const rawResult = await runAsTeacher(teacherId, () =>
      deps.aiInput.saveRawInput.saveRawInput({
        teacherId,
        inputType: 'text',
        text: '今天给小明上了数学课，作业是完成第三单元练习',
      }),
    );
    expect(rawResult.ok).toBe(true);
    expect(runCalls).toBe(2); // intent_recognition + information_extraction

    expect(deps.agent).toBeUndefined();

    // ProviderUsage 落行：2 行（2 run），tokens 全部非 0（修复前恒 0）
    const rows = await prisma.providerUsage.findMany({ where: { teacherId } });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.promptTokens).toBeGreaterThan(0);
      expect(row.completionTokens).toBeGreaterThan(0);
      expect(row.providerConfigId).toBe(configId);
    }

    // summary 非 0（qa3 P1：修复前 totals 恒 0）
    const from = new Date(Date.now() - 3600 * 1000);
    const to = new Date(Date.now() + 3600 * 1000);
    const summary = await deps.provider.providerUsageService.summary(teacherId, from, to);
    expect(summary.totals.requests).toBe(2);
    expect(summary.totals.promptTokens).toBe(25 + 25);
    expect(summary.totals.completionTokens).toBe(7 + 7);
    expect(summary.totals.totalTokens).toBe(25 + 25 + 7 + 7);
  });
});
