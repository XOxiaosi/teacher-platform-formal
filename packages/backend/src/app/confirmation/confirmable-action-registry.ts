import { err, internalError, ok } from '@teacher-platform/contracts';
import {
  CONFIRMABLE_ACTION_NAMES,
  type ConfirmableActionName,
} from '../../features/pending-action/index.js';
import type {
  ConfirmableActionExecutor,
  ConfirmableActionExecutorMap,
  ConfirmableActionRegistry,
} from './types.js';

const REQUIRED_ACTIONS = new Set<string>(CONFIRMABLE_ACTION_NAMES);

export function createConfirmableActionRegistry(
  source: ConfirmableActionExecutorMap,
): ConfirmableActionRegistry {
  const keys = Object.keys(source);
  if (CONFIRMABLE_ACTION_NAMES.some((actionName) => !keys.includes(actionName))) {
    throw new Error('ConfirmableActionRegistry 必须完整映射全部已批准动作');
  }
  if (keys.some((actionName) => !REQUIRED_ACTIONS.has(actionName)) || keys.length !== REQUIRED_ACTIONS.size) {
    throw new Error('ConfirmableActionRegistry 只能映射已批准动作');
  }

  const executors = Object.freeze({ ...source });
  for (const actionName of CONFIRMABLE_ACTION_NAMES) {
    if (typeof executors[actionName]?.execute !== 'function') {
      throw new Error(`ConfirmableActionRegistry executor 无效：${actionName}`);
    }
  }

  return Object.freeze({
    get(actionName: string) {
      if (!REQUIRED_ACTIONS.has(actionName)) {
        return err(internalError('待确认操作类型未注册'));
      }
      return ok(executors[actionName as ConfirmableActionName] as ConfirmableActionExecutor);
    },
  });
}
