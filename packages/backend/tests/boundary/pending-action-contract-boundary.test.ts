import { readPrismaSchema } from '../helpers/prisma-schema.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = readPrismaSchema();
const stateTools = readFileSync(resolve(__dirname, '../../src/app/tools/register-p0-state-tools.ts'), 'utf8');

function modelBody(modelName: string): string {
  const match = schema.match(new RegExp(`model ${modelName} \\{([\\s\\S]*?)\\n\\}`));
  return match?.[1] ?? '';
}

describe('P5.2 PendingAction schema 契约红灯', () => {
  it('PendingAction 绑定 teacher、conversation、toolCall、动作、对象、参数和可信过期状态', () => {
    const body = modelBody('PendingAction');

    expect(body).not.toBe('');
    expect(body).toMatch(/id\s+String\s+@id\s+@default\(cuid\(\)\)/);
    expect(body).toMatch(/teacherId\s+String/);
    expect(body).toMatch(/conversationId\s+String/);
    expect(body).toMatch(/toolCallId\s+String/);
    expect(body).toMatch(/actionName\s+String/);
    expect(body).toMatch(/targetType\s+String/);
    expect(body).toMatch(/targetId\s+String/);
    expect(body).toMatch(/parameters\s+Json/);
    expect(body).toMatch(/beforeSummary\s+String\?/);
    expect(body).toMatch(/afterSummary\s+String/);
    expect(body).toMatch(/status\s+String\s+@default\("pending"\)/);
    expect(body).toMatch(/expiresAtTs\s+DateTime/);
    expect(body).toMatch(/consumedAtTs\s+DateTime\?/);
    expect(body).toMatch(/cancelledAtTs\s+DateTime\?/);
  });

  it('PendingAction 有会话关系、幂等唯一键且无低区分度 teacherId 索引', () => {
    const body = modelBody('PendingAction');
    const conversation = modelBody('Conversation');

    expect(body).toContain('conversation Conversation @relation(fields: [conversationId], references: [id])');
    expect(body).toContain('@@unique([teacherId, toolCallId])');
    // D50 §6.1 索引精简：独立库下 teacherId 无区分度，业务表不再建 teacherId 复合索引
    expect(body).not.toContain('@@index([teacherId, status, expiresAtTs])');
    expect(body).toContain('@@index([conversationId])');
    expect(conversation).toContain('pendingActions PendingAction[]');
  });
});

describe('P5.2 状态工具确认边界红灯', () => {
  it('可用状态工具不再暴露可由模型伪造的 confirm 布尔参数', () => {
    expect(stateTools).not.toMatch(/\bconfirm\b/);
    expect(stateTools).not.toContain('requireConfirm');
  });

  it('仍可用的两个高风险工具显式声明 required confirmation policy', () => {
    const actionNames = [
      'scheduling.cancel',
      'students.updateStatus',
    ];

    for (const actionName of actionNames) {
      const definitionStart = stateTools.indexOf(`name: '${actionName}'`);
      expect(definitionStart).toBeGreaterThan(-1);
      const definitionWindow = stateTools.slice(definitionStart, definitionStart + 700);
      expect(definitionWindow).toMatch(/confirmation\s*:\s*['"]required['"]/);
    }
    expect(stateTools).not.toContain("name: 'scheduling.complete'");
    expect(stateTools).not.toContain("name: 'lessons.updateStatus'");
  });
});
