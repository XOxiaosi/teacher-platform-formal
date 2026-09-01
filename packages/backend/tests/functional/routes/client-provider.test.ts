import { describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  createClientProvider,
  getRequestDb,
  runWithRequestDb,
} from '../../../src/shared/database-pool/index.js';
import { createStudentService } from '../../../src/features/students/index.js';
import { createStudentTimelineService } from '../../../src/features/student-timeline/index.js';
import { createStudentProfileUseCase } from '../../../src/app/use-cases/student-profile/index.js';
import { createBalanceCalcUseCase } from '../../../src/app/use-cases/balance-calc/index.js';

function fakeClient(name: string) {
  return {
    $queryRaw: vi.fn(),
    $disconnect: vi.fn(),
    name,
    student: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      findUnique: vi.fn(async () => null),
    },
  } as unknown as PrismaClient;
}

describe('createClientProvider（请求期 getClient 解析，S2）', () => {
  it('无请求上下文时回退装配期 client', async () => {
    const fallback = fakeClient('fallback');
    const provider = createClientProvider(fallback);
    expect(await provider.getClient()).toBe(fallback);
  });

  it('runWithRequestDb 内 getClient 返回请求路由的 client', async () => {
    const fallback = fakeClient('fallback');
    const routed = fakeClient('teacher_db_a');
    const provider = createClientProvider(fallback);

    let resolved: PrismaClient | undefined;
    await runWithRequestDb({ client: routed, dbName: 'teacher_db_a' }, async () => {
      resolved = await provider.getClient();
    });
    expect(resolved).toBe(routed);
  });

  it('getRequestDb 返回当前上下文，上下文外返回 undefined', () => {
    expect(getRequestDb()).toBeUndefined();
    runWithRequestDb({ client: fakeClient('a'), dbName: 'teacher_db_a' }, () => {
      expect(getRequestDb()?.dbName).toBe('teacher_db_a');
    });
  });
});

describe('students 组工厂 getClient 平移（S2，向后兼容）', () => {
  it('createStudentService 旧签名 createStudentService(prisma) 仍可用', async () => {
    const service = createStudentService(fakeClient('legacy'));
    const result = await service.listStudents({ teacherId: 't1' });
    expect(result.ok).toBe(true);
  });

  it('createStudentService({ getClient }) 每次调用经 getClient 解析', async () => {
    const client = fakeClient('teacher_db_a');
    const getClient = vi.fn(async () => client);
    const service = createStudentService({ getClient });

    await service.listStudents({ teacherId: 't1' });
    await service.getStudent('s1');
    expect(getClient).toHaveBeenCalledTimes(2);
  });

  it('createStudentTimelineService 双签名兼容', () => {
    const legacy = createStudentTimelineService(fakeClient('legacy'));
    const routed = createStudentTimelineService({ getClient: async () => fakeClient('a') });
    expect(typeof legacy.getStudentTimeline).toBe('function');
    expect(typeof routed.getStudentTimeline).toBe('function');
  });

  it('createStudentProfileUseCase 双签名兼容', () => {
    const legacy = createStudentProfileUseCase(fakeClient('legacy'));
    const routed = createStudentProfileUseCase({ getClient: async () => fakeClient('a') });
    expect(typeof legacy.execute).toBe('function');
    expect(typeof routed.execute).toBe('function');
  });

  it('createBalanceCalcUseCase 双签名兼容', () => {
    const legacy = createBalanceCalcUseCase(fakeClient('legacy'));
    const routed = createBalanceCalcUseCase({ getClient: async () => fakeClient('a') });
    expect(typeof legacy.calculateBalance).toBe('function');
    expect(typeof routed.calculateBalance).toBe('function');
  });
});
