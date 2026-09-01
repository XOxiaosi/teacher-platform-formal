import type { Logger } from '../../shared/logger/index.js';
import type { ModerationAdapter } from '../../shared/platform-services/index.js';
import { LOCAL_MODERATION_RULES } from '../../shared/platform-services/moderation/rules.js';

const SAFE_REASONS = new Set(LOCAL_MODERATION_RULES.map((rule) => `${rule.id}（${rule.description}）`));

export interface CommunicationModerationProjection {
  summary: string;
  sourceText?: string | null;
  parentConcerns: string[];
  teacherResponses: string[];
  agreements: string[];
  followUps: string[];
}

export interface CommunicationModerationResult {
  flagged: boolean;
  reasons: string[];
}

function list(label: string, values: string[]): string {
  return `${label}:\n${values.map((value) => `- ${value}`).join('\n')}`;
}

export function buildCommunicationModerationProjection(
  projection: CommunicationModerationProjection,
): string {
  return [
    `StudentRecord.summary:\n${projection.summary}`,
    ...(projection.sourceText != null
      ? [`StudentSourceRecord.rawText:\n${projection.sourceText}`]
      : []),
    list('CommunicationDetail.parentConcerns', projection.parentConcerns),
    list('CommunicationDetail.teacherResponses', projection.teacherResponses),
    list('CommunicationDetail.agreements', projection.agreements),
    list('CommunicationDetail.followUps', projection.followUps),
  ].join('\n\n');
}

export async function moderateCommunicationProjection(input: {
  moderation?: ModerationAdapter;
  logger?: Logger;
  teacherId?: string;
  recordId?: string;
  projection: CommunicationModerationProjection;
}): Promise<CommunicationModerationResult | undefined> {
  if (input.moderation?.provider !== 'local') return undefined;
  try {
    const result = await input.moderation.moderateText({
      text: buildCommunicationModerationProjection(input.projection),
      scene: 'communication',
    });
    if (result.verdict === 'pass' && result.flagged === false && Array.isArray(result.reasons)) {
      return { flagged: false, reasons: [] };
    }
    if (result.verdict === 'review' && result.flagged === true && Array.isArray(result.reasons)) {
      return {
        flagged: true,
        reasons: result.reasons.filter((reason) => SAFE_REASONS.has(reason)),
      };
    }
    return undefined;
  } catch {
    input.logger?.warn('communication moderation check failed', {
      teacherId: input.teacherId,
      recordId: input.recordId,
      errorCode: 'LOCAL_MODERATION_FAILED',
      errorType: 'ModerationError',
    });
    return undefined;
  }
}
