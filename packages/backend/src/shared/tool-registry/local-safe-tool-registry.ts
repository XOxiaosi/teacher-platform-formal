import { err, validationError } from '@teacher-platform/contracts';
import type { ToolDefinition, ToolRegistry } from './types.js';

export function isLocalSafeTool(definition: ToolDefinition): boolean {
  return definition.sideEffect === 'read' || definition.confirmation === 'required';
}

/**
 * L0 本地安全视图：不改变底层注册与确认执行语义，只收窄 Agent 可见/可执行工具。
 * list 隐藏直写工具；execute 重新按元数据判定，避免调用方绕过 list 直接按名称执行。
 */
export function createLocalSafeToolRegistry(registry: ToolRegistry): ToolRegistry {
  return {
    register(definition, handler) {
      return registry.register(definition, handler);
    },

    list() {
      return registry.list().filter(isLocalSafeTool);
    },

    async execute(name, args, context) {
      const definition = registry.list().find((tool) => tool.name === name);
      if (definition && !isLocalSafeTool(definition)) {
        return err(validationError(
          `本地安全模式禁止直接执行未确认写工具 ${name}`,
          'localSafeMode',
        ));
      }
      return registry.execute(name, args, context);
    },
  };
}
