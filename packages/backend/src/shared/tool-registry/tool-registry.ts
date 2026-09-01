import { ok, err, notFound, validationError, internalError } from '@teacher-platform/contracts';
import type { ToolDefinition, ToolHandler, ToolRegistry, ToolSideEffect } from './types.js';

const TOOL_SIDE_EFFECTS = new Set<ToolSideEffect>([
  'read',
  'create',
  'update',
  'destructive',
]);

interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, RegisteredTool>();

  return {
    register(definition, handler) {
      if (!definition.name || definition.name.trim() === '') {
        return err(validationError('工具名称不能为空', 'name'));
      }
      if (!definition.description || definition.description.trim() === '') {
        return err(validationError('工具描述不能为空', 'description'));
      }
      if (!definition.parameters) {
        return err(validationError('工具参数定义不能为空', 'parameters'));
      }
      if (!TOOL_SIDE_EFFECTS.has(definition.sideEffect)) {
        return err(validationError(
          '工具副作用分类必须是 read/create/update/destructive',
          'sideEffect',
        ));
      }
      if (typeof handler !== 'function') {
        return err(validationError('handler 必须是函数', 'handler'));
      }
      if (tools.has(definition.name)) {
        return err(validationError(`工具 ${definition.name} 已注册`, 'name'));
      }

      tools.set(definition.name, { definition: structuredClone(definition), handler });
      return ok(structuredClone(definition));
    },

    list() {
      return Array.from(tools.values()).map(({ definition }) => structuredClone(definition));
    },

    async execute(name, args, context) {
      const tool = tools.get(name);
      if (!tool) {
        return err(notFound(`工具 ${name} 未注册`));
      }

      try {
        return await tool.handler(args, context);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`工具 ${name} 执行异常: ${message}`));
      }
    },
  };
}
