import { describe, expect, it, vi } from 'vitest';
import { internalError, ok, versionConflict } from '@teacher-platform/contracts';

let createUpdateMemoUseCaseWithServices: unknown;
let importError: unknown;
try {
  const module = await import('../../../src/app/use-cases/update-memo/update-memo-use-case.js');
  createUpdateMemoUseCaseWithServices = module.createUpdateMemoUseCaseWithServices;
} catch (caught) {
  importError = caught;
}

const before = {
  id: 'memo-1',
  teacherId: 'teacher-1',
  title: '原备忘',
  content: '原内容',
  status: 'active' as const,
  dueAt: new Date('2030-06-01T00:00:00.000Z'),
  tags: { labels: ['物理'], priority: 1 },
  source: 'manual',
  createdAt: new Date('2029-01-01T00:00:00.000Z'),
  updatedAt: new Date('2030-01-01T00:00:00.000Z'),
};
const nextTags = {
  priority: 'high',
  labels: ['家长', { subject: '物理' }],
  archived: false,
};
const after = {
  ...before,
  title: '新备忘',
  content: '新内容',
  dueAt: new Date('2030-06-15T08:30:00.000Z'),
  tags: nextTags,
  updatedAt: new Date('2030-01-02T00:00:00.000Z'),
};
const changeLog = {
  id: 'change-1',
  teacherId: 'teacher-1',
  timestamp: new Date('2030-01-02T00:00:00.000Z'),
  module: 'memos',
  action: 'update',
  targetType: 'Memo',
  targetId: 'memo-1',
  before: null,
  after: null,
  diff: null,
  source: 'manual-web',
  operatorId: null,
};

function requireFactory() {
  if (importError) {
    throw new Error(
      `update-memo use-case import failed: ${importError instanceof Error ? importError.message : String(importError)}`,
    );
  }
  if (typeof createUpdateMemoUseCaseWithServices !== 'function') {
    throw new Error('createUpdateMemoUseCaseWithServices export is missing');
  }
  return createUpdateMemoUseCaseWithServices as (services: any) => {
    updateMemo(command: any): Promise<any>;
  };
}

function createServices(ownerResult: any = ok({ before, after }), changeResult: any = ok(changeLog)) {
  const transactional = {
    memos: {
      updateMemo: vi.fn().mockResolvedValue(ownerResult),
    },
    changelog: {
      recordChange: vi.fn().mockResolvedValue(changeResult),
    },
  };
  return {
    transactional,
    transaction: vi.fn(async (work: (services: typeof transactional) => Promise<any>) => work(transactional)),
  };
}

function validCommand() {
  return {
    teacherId: 'teacher-1',
    memoId: 'memo-1',
    expectedUpdatedAt: '2030-01-01T08:00:00+08:00',
    source: 'manual-web',
    changes: {
      title: '新备忘',
      content: '新内容',
      dueAt: '2030-06-15T16:30:00+08:00',
      tags: nextTags,
    },
  };
}

describe('UpdateMemoUseCase application contract', () => {
  it('导出可注入事务服务的Memo use-case', () => {
    expect(requireFactory()).toBeTypeOf('function');
  });

  it.each(['manual-web', 'agent-confirmed', 'wechat-confirmed'])('%s 缺少expected时在事务前返回VALIDATION_ERROR', async (source) => {
    const services = createServices();
    const useCase = requireFactory()(services);

    const result = await useCase.updateMemo({
      ...validCommand(),
      source,
      expectedUpdatedAt: undefined,
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'expectedUpdatedAt' }),
    });
    expect(services.transaction).not.toHaveBeenCalled();
  });

  it.each([
    '2030-01-01T00:00:00',
    '2030-02-30T00:00:00Z',
    '2030-01-01T24:00:00Z',
    'not-an-instant',
  ])('拒绝非严格RFC3339 expected：%s', async (expectedUpdatedAt) => {
    const services = createServices();
    const useCase = requireFactory()(services);

    const result = await useCase.updateMemo({ ...validCommand(), expectedUpdatedAt });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'expectedUpdatedAt' }),
    });
    expect(services.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { changes: {}, field: 'changes' },
    { changes: null, field: 'changes' },
    { changes: [], field: 'changes' },
    { changes: { status: 'done' }, field: 'changes' },
    { changes: { source: 'agent' }, field: 'changes' },
    { changes: { title: 42 }, field: 'title' },
    { changes: { content: null }, field: 'content' },
    { changes: { dueAt: new Date('2030-01-01T00:00:00.000Z') }, field: 'dueAt' },
    { changes: { dueAt: '2030-06-15T16:30:00' }, field: 'dueAt' },
    { changes: { dueAt: '2030-02-30T00:00:00Z' }, field: 'dueAt' },
    { changes: { tags: undefined }, field: 'tags' },
    { changes: { tags: Number.NaN }, field: 'tags' },
    { changes: { tags: Number.POSITIVE_INFINITY }, field: 'tags' },
    { changes: { tags: Array(1) }, field: 'tags' },
    { changes: { tags: BigInt(1) }, field: 'tags' },
    { changes: { tags: new Date('2030-01-01T00:00:00.000Z') }, field: 'tags' },
    { changes: { tags: { valid: true, nested: undefined } }, field: 'tags' },
  ])('在事务前拒绝非法changes：$field/$changes', async ({ changes, field }) => {
    const services = createServices();
    const useCase = requireFactory()(services);

    const result = await useCase.updateMemo({ ...validCommand(), changes });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field }),
    });
    expect(services.transaction).not.toHaveBeenCalled();
  });

  it('拒绝循环JSON与非普通对象', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const custom = Object.create({ inherited: true }) as Record<string, unknown>;
    custom.value = 'x';
    const services = createServices();
    const useCase = requireFactory()(services);

    const cyclicResult = await useCase.updateMemo({
      ...validCommand(),
      changes: { tags: cyclic },
    });
    const customResult = await useCase.updateMemo({
      ...validCommand(),
      changes: { tags: custom },
    });

    expect(cyclicResult).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'tags' }),
    });
    expect(customResult).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'tags' }),
    });
    expect(services.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { patch: { teacherId: ' ' }, field: 'teacherId' },
    { patch: { memoId: '' }, field: 'memoId' },
    { patch: { source: 'manual' }, field: 'source' },
  ])('拒绝不可信命令元数据：$field', async ({ patch, field }) => {
    const services = createServices();
    const useCase = requireFactory()(services);

    const result = await useCase.updateMemo({ ...validCommand(), ...patch });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field }),
    });
    expect(services.transaction).not.toHaveBeenCalled();
  });

  it('解析expected与dueAt，递归投影JSON并返回receipt', async () => {
    const services = createServices();
    const useCase = requireFactory()(services);

    const result = await useCase.updateMemo(validCommand());

    expect(services.transactional.memos.updateMemo).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      memoId: 'memo-1',
      expectedUpdatedAt: new Date('2030-01-01T00:00:00.000Z'),
      changes: {
        title: '新备忘',
        content: '新内容',
        dueAt: new Date('2030-06-15T08:30:00.000Z'),
        tags: nextTags,
      },
    });
    expect(result).toEqual(ok({ value: after, changeLogId: 'change-1' }));
  });

  it('dueAt与tags的null清空语义原样传给owner', async () => {
    const cleared = { ...after, dueAt: null, tags: null };
    const services = createServices(ok({ before, after: cleared }));
    const useCase = requireFactory()(services);

    const result = await useCase.updateMemo({
      ...validCommand(),
      changes: { dueAt: null, tags: null },
    });

    expect(result.ok).toBe(true);
    expect(services.transactional.memos.updateMemo).toHaveBeenCalledWith(
      expect.objectContaining({ changes: { dueAt: null, tags: null } }),
    );
  });

  it('空白文本领域规则交给owner，以保持版本优先级', async () => {
    const ownerError = { ok: false, error: versionConflict() };
    const services = createServices(ownerError);
    const useCase = requireFactory()(services);

    const result = await useCase.updateMemo({
      ...validCommand(),
      changes: { title: '   ', content: '' },
    });

    expect(result).toEqual(ownerError);
    expect(services.transactional.memos.updateMemo).toHaveBeenCalledWith(
      expect.objectContaining({ changes: { title: '   ', content: '' } }),
    );
  });

  it('只用owner before/after生成Memo字段审计快照并透传可信source', async () => {
    const services = createServices();
    const useCase = requireFactory()(services);

    await useCase.updateMemo(validCommand());

    expect(services.transactional.changelog.recordChange).toHaveBeenCalledTimes(1);
    expect(services.transactional.changelog.recordChange).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      module: 'memos',
      action: 'update',
      targetType: 'Memo',
      targetId: 'memo-1',
      before: {
        title: '原备忘',
        content: '原内容',
        dueAt: '2030-06-01T00:00:00.000Z',
        tags: { labels: ['物理'], priority: 1 },
        updatedAt: '2030-01-01T00:00:00.000Z',
      },
      after: {
        title: '新备忘',
        content: '新内容',
        dueAt: '2030-06-15T08:30:00.000Z',
        tags: nextTags,
        updatedAt: '2030-01-02T00:00:00.000Z',
      },
      source: 'manual-web',
    });
  });

  it('owner失败时不调用ChangeLog并保持原错误', async () => {
    const ownerError = { ok: false, error: versionConflict() };
    const services = createServices(ownerError);
    const useCase = requireFactory()(services);

    const result = await useCase.updateMemo(validCommand());

    expect(result).toEqual(ownerError);
    expect(services.transactional.changelog.recordChange).not.toHaveBeenCalled();
  });

  it('ChangeLog失败时保持INTERNAL_ERROR结果', async () => {
    const auditError = { ok: false, error: internalError('审计失败') };
    const services = createServices(undefined, auditError);
    const useCase = requireFactory()(services);

    const result = await useCase.updateMemo(validCommand());

    expect(result).toEqual(auditError);
  });

  it('受控system来源可省略expected但仍进入同一owner命令', async () => {
    const services = createServices();
    const useCase = requireFactory()(services);

    const result = await useCase.updateMemo({
      ...validCommand(),
      source: 'system',
      expectedUpdatedAt: undefined,
    });

    expect(result.ok).toBe(true);
    expect(services.transactional.memos.updateMemo).toHaveBeenCalledWith(
      expect.objectContaining({ expectedUpdatedAt: undefined }),
    );
  });
});
