import { describe, it, expect } from 'vitest';
import { createToolRegistry } from '../../../src/shared/tool-registry/index.js';

const DUMMY_DEFINITION = {
  name: 'createStudent',
  description: '创建学生',
  parameters: { name: { type: 'string', required: true } },
  sideEffect: 'create' as const,
};

describe('toolRegistry.register', () => {
  it('注册后 list 返回定义，不暴露 handler', () => {
    const registry = createToolRegistry();

    const result = registry.register(DUMMY_DEFINITION, async () => ({ ok: true, value: {} }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('createStudent');

    const tools = registry.list();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject(DUMMY_DEFINITION);
    // list 返回的对象不应包含 handler 属性
    expect(tools[0]).not.toHaveProperty('handler');
  });

  it('重名工具注册返回 VALIDATION_ERROR', () => {
    const registry = createToolRegistry();
    registry.register(DUMMY_DEFINITION, async () => ({ ok: true, value: {} }));

    const result = registry.register(DUMMY_DEFINITION, async () => ({ ok: true, value: {} }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('空 name 返回 VALIDATION_ERROR', () => {
    const registry = createToolRegistry();

    const result = registry.register(
      { ...DUMMY_DEFINITION, name: '' },
      async () => ({ ok: true, value: {} }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('空 description 返回 VALIDATION_ERROR', () => {
    const registry = createToolRegistry();

    const result = registry.register(
      { ...DUMMY_DEFINITION, description: '' },
      async () => ({ ok: true, value: {} }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('缺 parameters 返回 VALIDATION_ERROR', () => {
    const registry = createToolRegistry();

    const result = registry.register(
      { name: 'test', description: 'test', sideEffect: 'read' } as never,
      async () => ({ ok: true, value: {} }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('缺 sideEffect 返回 VALIDATION_ERROR', () => {
    const registry = createToolRegistry();

    const result = registry.register(
      { name: 'test', description: 'test', parameters: {} } as never,
      async () => ({ ok: true, value: {} }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: 'VALIDATION_ERROR', field: 'sideEffect' });
  });

  it('非法 sideEffect 返回 VALIDATION_ERROR', () => {
    const registry = createToolRegistry();

    const result = registry.register(
      { name: 'test', description: 'test', parameters: {}, sideEffect: 'write' } as never,
      async () => ({ ok: true, value: {} }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: 'VALIDATION_ERROR', field: 'sideEffect' });
  });

  it('handler 非函数返回 VALIDATION_ERROR', () => {
    const registry = createToolRegistry();

    const result = registry.register(DUMMY_DEFINITION, 'not a function' as never);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('handler');
  });

  it('注册后修改原始 definition，不影响 registry 内部状态', () => {
    const registry = createToolRegistry();
    const definition = {
      name: 'testTool',
      description: '测试工具',
      parameters: { field: { type: 'string' } },
      sideEffect: 'read' as const,
    };

    registry.register(definition, async () => ({ ok: true, value: {} }));

    // 修改原始对象
    definition.parameters.field = { type: 'number' };
    definition.name = 'hacked';

    const listed = registry.list();
    expect(listed[0].name).toBe('testTool');
    expect(listed[0].parameters).toEqual({ field: { type: 'string' } });
  });

  it('修改 list() 返回对象，不影响 registry 内部状态', () => {
    const registry = createToolRegistry();
    registry.register(DUMMY_DEFINITION, async () => ({ ok: true, value: {} }));

    const listed = registry.list();
    listed[0].name = 'hacked';
    listed[0].parameters.field = { type: 'number' };

    // 再次 list，内部状态不变
    const listed2 = registry.list();
    expect(listed2[0].name).toBe('createStudent');
    expect(listed2[0].parameters).toEqual({ name: { type: 'string', required: true } });
  });
});

describe('toolRegistry.execute', () => {
  it('调用真实 handler，透传 args 和 context', async () => {
    const registry = createToolRegistry();
    let capturedArgs: unknown;
    let capturedContext: unknown;

    registry.register(DUMMY_DEFINITION, async (args, context) => {
      capturedArgs = args;
      capturedContext = context;
      return { ok: true, value: { id: 'student-1' } };
    });

    const args = { name: '张三', grade: '高三' };
    const context = { teacherId: 'teacher-1' };
    const result = await registry.execute('createStudent', args, context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ id: 'student-1' });
    expect(capturedArgs).toBe(args);
    expect(capturedContext).toBe(context);
  });

  it('未知工具名返回 NOT_FOUND', async () => {
    const registry = createToolRegistry();

    const result = await registry.execute('nonexistent', {}, { teacherId: 't1' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('handler 返回错误不被吞掉', async () => {
    const registry = createToolRegistry();
    registry.register(DUMMY_DEFINITION, async () => {
      return { ok: false, error: { code: 'VALIDATION_ERROR' as const, message: '姓名不能为空', field: 'name' } };
    });

    const result = await registry.execute('createStudent', {}, { teacherId: 't1' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.message).toBe('姓名不能为空');
    expect(result.error.field).toBe('name');
  });

  it('handler throw 被包装为 INTERNAL_ERROR', async () => {
    const registry = createToolRegistry();
    registry.register(DUMMY_DEFINITION, async () => {
      throw new Error('数据库连接失败');
    });

    const result = await registry.execute('createStudent', {}, { teacherId: 't1' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL_ERROR');
    expect(result.error.message).toContain('数据库连接失败');
  });
});

describe('toolRegistry 实例隔离', () => {
  it('两个 createToolRegistry() 之间不共享工具', () => {
    const registry1 = createToolRegistry();
    const registry2 = createToolRegistry();

    registry1.register(DUMMY_DEFINITION, async () => ({ ok: true, value: {} }));

    expect(registry1.list()).toHaveLength(1);
    expect(registry2.list()).toHaveLength(0);
  });
});
