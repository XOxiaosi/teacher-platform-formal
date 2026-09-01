import { err, internalError } from '@teacher-platform/contracts';
import type { CodeExchanger } from './types.js';

/**
 * 默认 code 交换器：iLink 供应商协议未冻结（W0 前置）前不可用。
 * 装配/测试经 createWechatLoginRouter options.codeExchanger 注入真实或假实现；
 * 生产接入 = W0 协议冻结后按供应商文档实现（code → bot_token/ilink_user_id 服务端交换）。
 */
export function createUnavailableCodeExchanger(): CodeExchanger {
  return {
    async exchange() {
      return err(internalError('iLink code 交换未接入（供应商协议冻结 W0 前置）'));
    },
  };
}
