import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/shared/logger/index.js';
import type { ModerationAdapter } from '../../../src/shared/platform-services/index.js';

const capturedServiceOptions = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('../../../src/features/student-communications/index.js', () => ({
  createCommunicationService: vi.fn((options: Record<string, unknown>) => {
    capturedServiceOptions.push(options);
    return { createCommunicationRecord: vi.fn() };
  }),
}));

import { createMinimalToolRegistry } from '../../../src/app/tool-registration.js';

const prisma = {} as PrismaClient;
const trustedClock = { now: vi.fn() } as never;
const logger = { warn: vi.fn() } as unknown as Logger;

function moderation(provider: string): ModerationAdapter {
  return { provider, moderateText: vi.fn() };
}

function createRegistry(adapter?: ModerationAdapter) {
  capturedServiceOptions.length = 0;
  const registry = createMinimalToolRegistry({
    prisma,
    trustedClock,
    moderation: adapter,
    logger,
  });
  expect(capturedServiceOptions).toHaveLength(1);
  return { registry, serviceOptions: capturedServiceOptions[0] };
}

describe('Agent communication capture moderation wiring', () => {
  it('local adapter 注入 moderation/logger，且可信来源固定为 agent', () => {
    const local = moderation('local');
    const { serviceOptions } = createRegistry(local);

    expect(serviceOptions).toMatchObject({
      moderation: local,
      logger,
      auditSource: 'agent',
    });
  });

  it.each([
    ['external', moderation('external')],
    ['undefined', undefined],
  ])('%s adapter 不透传 moderation/logger，但仍固定可信来源', (_label, adapter) => {
    const { serviceOptions } = createRegistry(adapter);

    expect(serviceOptions).toMatchObject({ auditSource: 'agent' });
    expect(serviceOptions).not.toHaveProperty('moderation');
    expect(serviceOptions).not.toHaveProperty('logger');
  });

  it('capture 工具请求 schema 不暴露 auditSource', () => {
    const { registry } = createRegistry(moderation('local'));
    const capture = registry.list().find((tool) => tool.name === 'students.communications.capture');

    expect(capture).toBeDefined();
    const parameters = capture!.parameters as { properties?: Record<string, unknown> };
    expect(parameters.properties).toBeDefined();
    expect(parameters.properties).not.toHaveProperty('auditSource');
  });
});
