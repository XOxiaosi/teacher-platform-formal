import { describe, expect, it, vi } from 'vitest';
import {
  buildCommunicationModerationProjection,
  moderateCommunicationProjection,
} from '../../../src/features/student-communications/communication-moderation.js';
import { LOCAL_MODERATION_RULES } from '../../../src/shared/platform-services/moderation/rules.js';

const projection = {
  summary: '摘要',
  sourceText: '原始文字',
  parentConcerns: ['诉求一', '诉求二'],
  teacherResponses: ['回应'],
  agreements: ['共识'],
  followUps: ['跟进'],
};

describe('communication moderation', () => {
  it('组装稳定标签化完整投影', () => {
    expect(buildCommunicationModerationProjection(projection)).toBe([
      'StudentRecord.summary:\n摘要',
      'StudentSourceRecord.rawText:\n原始文字',
      'CommunicationDetail.parentConcerns:\n- 诉求一\n- 诉求二',
      'CommunicationDetail.teacherResponses:\n- 回应',
      'CommunicationDetail.agreements:\n- 共识',
      'CommunicationDetail.followUps:\n- 跟进',
    ].join('\n\n'));
  });

  it('仅 local 调用，并把恶意 reason 过滤到规则白名单', async () => {
    const safe = `${LOCAL_MODERATION_RULES[0].id}（${LOCAL_MODERATION_RULES[0].description}）`;
    const moderateText = vi.fn().mockResolvedValue({
      verdict: 'review', labels: [], flagged: true, reasons: [safe, '明文泄露'],
    });
    await expect(moderateCommunicationProjection({
      moderation: { provider: 'local', moderateText }, projection,
    })).resolves.toEqual({ flagged: true, reasons: [safe] });
    expect(moderateText).toHaveBeenCalledWith({
      text: buildCommunicationModerationProjection(projection), scene: 'communication',
    });
  });

  it.each(['external', 'none'])('%s provider 零调用', async (provider) => {
    const moderateText = vi.fn();
    await expect(moderateCommunicationProjection({
      moderation: { provider, moderateText }, projection,
    })).resolves.toBeUndefined();
    expect(moderateText).not.toHaveBeenCalled();
  });

  it('pass 返回 false/[]；异常和 malformed 返回 undefined 且安全日志不含正文或异常内容', async () => {
    await expect(moderateCommunicationProjection({
      moderation: { provider: 'local', moderateText: vi.fn().mockResolvedValue({ verdict: 'pass', labels: [], flagged: false, reasons: [] }) },
      projection,
    })).resolves.toEqual({ flagged: false, reasons: [] });

    const warn = vi.fn();
    await expect(moderateCommunicationProjection({
      moderation: { provider: 'local', moderateText: vi.fn().mockRejectedValue(new Error('SECRET_STACK')) },
      projection,
      logger: { warn } as never,
      teacherId: 'teacher-1',
      recordId: 'record-1',
    })).resolves.toBeUndefined();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET_STACK');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('原始文字');

    await expect(moderateCommunicationProjection({
      moderation: { provider: 'local', moderateText: vi.fn().mockResolvedValue({ verdict: 'review', labels: [] }) },
      projection,
    })).resolves.toBeUndefined();
    await expect(moderateCommunicationProjection({
      moderation: {
        provider: 'local',
        moderateText: vi.fn().mockResolvedValue({
          verdict: 'pass', labels: [], flagged: true, reasons: [],
        }),
      },
      projection,
    })).resolves.toBeUndefined();
  });
});
