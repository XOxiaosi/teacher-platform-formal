import { err, validationError } from '@teacher-platform/contracts';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { ToolDefinition, ToolRegistry } from '../../shared/tool-registry/types.js';

// A02 starts with audited queries. An upstream plugin or legacy confirmation
// registration cannot expand the capabilities of the teaching runtime.
const QUERY_NAMES = new Set([
  'students.get', 'students.list', 'students.balance', 'scheduling.list', 'lessons.list',
  'payments.list', 'feedback.list', 'memos.list',
]);

export interface TeachingQueryTools {
  definitions: readonly ToolDefinition[];
  execute(name: string, args: unknown): Promise<Result<unknown, CommonError>>;
}

export function createTeachingQueryTools(registry: ToolRegistry, teacherId: string): TeachingQueryTools {
  if (!teacherId.trim()) throw new Error('Teaching tools require an authenticated teacher');
  const allowed = (tool: ToolDefinition) => QUERY_NAMES.has(tool.name)
    && tool.sideEffect === 'read' && tool.confirmation !== 'required';
  const definitions = registry.list().filter(allowed).map((tool) => structuredClone(tool));
  const exposed = new Set(definitions.map((tool) => tool.name));
  return {
    definitions,
    async execute(name, args) {
      const current = registry.list().find((tool) => tool.name === name);
      if (!exposed.has(name) || !current || !allowed(current)) {
        return err(validationError('当前教学助手不支持这项操作', 'tool'));
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return err(validationError('教学查询参数必须是对象', 'arguments'));
      }
      if (['teacherId', 'prisma', 'credentials', 'apiKey'].some((key) => Object.hasOwn(args, key))) {
        return err(validationError('查询不能指定账号或凭据', 'arguments'));
      }
      // Identity is supplied only by the authenticated platform task. It is
      // never taken from a model message, tool argument, or DSH workspace.
      return registry.execute(name, args, { teacherId });
    },
  };
}
