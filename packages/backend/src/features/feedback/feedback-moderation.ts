import type { Logger } from '../../shared/logger/index.js';
import type { ModerationAdapter } from '../../shared/platform-services/index.js';
import { LOCAL_MODERATION_RULES } from '../../shared/platform-services/moderation/rules.js';

const SAFE_LOCAL_MODERATION_REASONS = new Set(
  LOCAL_MODERATION_RULES.map((rule) => `${rule.id}（${rule.description}）`),
);

export interface FeedbackModerationResult {
  flagged: boolean;
  reasons: string[];
}

export async function moderateFeedbackForSend(input: {
  moderation?: ModerationAdapter;
  logger?: Logger;
  teacherId: string;
  feedbackId: string;
  title: string;
  content: string;
}): Promise<FeedbackModerationResult | undefined> {
  if (input.moderation?.provider !== 'local') return undefined;
  try {
    const result = await input.moderation.moderateText({
      text: `${input.title}\n${input.content}`,
      scene: 'feedback',
    });
    if (result.flagged !== true && result.verdict !== 'pass') return undefined;
    return {
      flagged: result.flagged === true,
      reasons: (result.reasons ?? []).filter((reason) => SAFE_LOCAL_MODERATION_REASONS.has(reason)),
    };
  } catch (error) {
    input.logger?.warn('feedback moderation check failed', {
      teacherId: input.teacherId,
      feedbackId: input.feedbackId,
      errorCode: 'LOCAL_MODERATION_FAILED',
      errorType: error instanceof Error ? 'Error' : 'NonError',
    });
    return undefined;
  }
}
