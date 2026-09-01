import type { CommonError, Result } from '@teacher-platform/contracts';

export type ToolSideEffect = 'read' | 'create' | 'update' | 'destructive';
export type ToolConfirmationPolicy = 'none' | 'required';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  sideEffect: ToolSideEffect;
  confirmation?: ToolConfirmationPolicy;
}

export interface ToolContext {
  teacherId: string;
  prisma?: unknown;
}

export type ToolHandler = (
  args: unknown,
  context: ToolContext,
) => Promise<Result<unknown, CommonError>>;

export interface ToolRegistry {
  register(definition: ToolDefinition, handler: ToolHandler): Result<ToolDefinition, CommonError>;
  list(): ToolDefinition[];
  execute(name: string, args: unknown, context: ToolContext): Promise<Result<unknown, CommonError>>;
}
