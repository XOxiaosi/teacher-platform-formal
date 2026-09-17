import { resolve } from 'node:path';
import { createRealDshTeachingRuntime } from '../teaching-runtime/real-dsh-runtime.js';
import type { DshUsageRecord } from '../teaching-runtime/dsh-adapter-contract.js';
import type { TeachingRuntimeDriver } from '../teaching-runtime/runtime-driver.js';
import type { ProviderUsageService } from '../../features/provider-usage/index.js';

/** Build the opt-in real DSH driver without coupling the main composition file
 * to the provider usage settlement details. The callback resolves the service
 * lazily because the composition assigns it after the driver is constructed. */
export function createConfiguredRealDshDriver(
  providerUsage: () => ProviderUsageService | undefined,
  env: NodeJS.ProcessEnv = process.env,
): TeachingRuntimeDriver | undefined {
  if (env.DSH_RUNTIME_ENABLED !== 'true' || !env.DSH_RUNTIME_ROOT) return undefined;
  return createRealDshTeachingRuntime({
    runtimeRoot: env.DSH_RUNTIME_ROOT,
    apiKeyFile: env.DEEPSEEK_API_KEY_FILE,
    model: env.DEEPSEEK_MODEL,
    sessionRoot: env.DSH_SESSION_ROOT,
    projectRoot: resolve(__dirname, '../../../../..'),
    onUsage: async (record: DshUsageRecord) => {
      const service = providerUsage();
      if (!service) throw new Error('DSH usage service unavailable');
      await service.record({
        teacherId: record.teacherId,
        providerName: 'deepseek',
        model: env.DEEPSEEK_MODEL ?? 'deepseek-flash',
        promptTokens: record.cost.inputTokens ?? 0,
        completionTokens: record.cost.outputTokens ?? 0,
        taskId: record.taskId,
        executionId: record.executionId,
        sessionId: record.sessionId,
        eventKey: record.eventKey,
        outcome: record.outcome,
        usageStatus: record.cost.usageStatus ?? 'unknown',
        synthetic: record.cost.synthetic,
      });
    },
  });
}
