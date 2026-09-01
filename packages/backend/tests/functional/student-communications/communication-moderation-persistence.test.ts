import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createCommunicationService } from '../../../src/features/student-communications/communication-service.js';
import { createFieldCipher, loadEncryptionKey } from '../../../src/shared/field-encryption/index.js';
import { LOCAL_MODERATION_RULES } from '../../../src/shared/platform-services/moderation/rules.js';

const prisma = new PrismaClient();
const cipher = createFieldCipher(loadEncryptionKey().key);
const teacherId = 'communication-moderation-teacher';
const otherTeacherId = 'communication-moderation-other';

async function cleanup() {
  const ids = { in: [teacherId, otherTeacherId] };
  await prisma.communicationDetail.deleteMany({ where: { teacherId: ids } });
  await prisma.studentRecord.deleteMany({ where: { teacherId: ids } });
  await prisma.studentSourceRecord.deleteMany({ where: { teacherId: ids } });
  await prisma.changeLog.deleteMany({ where: { teacherId: ids } });
  await prisma.student.deleteMany({ where: { teacherId: ids } });
}

beforeEach(cleanup);
afterEach(cleanup);

describe('communication moderation persistence', () => {
  it('create 用完整投影本地审核并持久化 flag，ChangeLog 只保存安全 reason', async () => {
    const student = await prisma.student.create({ data: { teacherId, name: '学生', grade: '高一' } });
    const safe = `${LOCAL_MODERATION_RULES[0].id}（${LOCAL_MODERATION_RULES[0].description}）`;
    const moderateText = vi.fn().mockResolvedValue({
      verdict: 'review', labels: [], flagged: true, reasons: [safe, 'EVIL_REASON'],
    });
    const service = createCommunicationService({
      getClient: async () => prisma,
      cipher,
      moderation: { provider: 'local', moderateText },
      auditSource: 'manual',
    });
    const result = await service.createCommunicationRecord({
      teacherId, studentId: student.id, summary: '摘要', sourceText: '原始文字',
      direction: 'two_way', parentConcerns: ['诉求'], teacherResponses: ['回应'],
      agreements: ['共识'], followUps: ['跟进'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.detail.moderationFlagged).toBe(true);
    expect(result.value.detail.moderationReasons).toEqual([safe]);
    expect(moderateText.mock.calls[0]?.[0].text).toContain('StudentRecord.summary:\n摘要');
    expect(moderateText.mock.calls[0]?.[0].text).toContain('StudentSourceRecord.rawText:\n原始文字');
    const logs = await prisma.changeLog.findMany({ where: { teacherId } });
    expect(JSON.stringify(logs)).not.toContain('原始文字');
    expect(JSON.stringify(logs)).not.toContain('EVIL_REASON');
  });

  it('external/none 零调用且 moderation 字段为 null', async () => {
    for (const provider of ['external', 'none']) {
      const student = await prisma.student.create({
        data: { teacherId, name: `学生-${provider}`, grade: '高一' },
      });
      const moderateText = vi.fn();
      const service = createCommunicationService({
        getClient: async () => prisma, cipher, moderation: { provider, moderateText },
      });
      const result = await service.createCommunicationRecord({
        teacherId, studentId: student.id, summary: '摘要', direction: 'inbound',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.detail.moderationFlagged).toBeNull();
        expect(result.value.detail.moderationReasons).toBeNull();
      }
      expect(moderateText).not.toHaveBeenCalled();
    }
  });

  it('PATCH 合并旧完整投影；非文本 patch 保留，文本审核失败清 null', async () => {
    const student = await prisma.student.create({ data: { teacherId, name: '学生', grade: '高一' } });
    const moderateText = vi.fn()
      .mockResolvedValueOnce({ verdict: 'review', labels: [], flagged: true, reasons: [] })
      .mockRejectedValueOnce(new Error('SECRET'));
    const service = createCommunicationService({
      getClient: async () => prisma, cipher,
      moderation: { provider: 'local', moderateText }, auditSource: 'agent',
    });
    const created = await service.createCommunicationRecord({
      teacherId, studentId: student.id, summary: '摘要', sourceText: '来源', direction: 'inbound',
      parentConcerns: ['旧诉求'], teacherResponses: ['旧回应'], agreements: ['旧共识'], followUps: ['旧跟进'],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const nonText = await service.updateDetail({
      teacherId, studentId: student.id, recordId: created.value.record.id,
      patch: { channel: 'phone' },
    });
    expect(nonText.ok && nonText.value.moderationFlagged).toBe(true);
    expect(moderateText).toHaveBeenCalledTimes(1);

    const text = await service.updateDetail({
      teacherId, studentId: student.id, recordId: created.value.record.id,
      patch: { parentConcerns: ['新诉求'] },
    });
    expect(text.ok).toBe(true);
    if (!text.ok) return;
    expect(text.value.moderationFlagged).toBeNull();
    expect(text.value.moderationReasons).toBeNull();
    expect(moderateText.mock.calls[1]?.[0].text).toContain('CommunicationDetail.teacherResponses:\n- 旧回应');
    const sources = await prisma.changeLog.findMany({ where: { teacherId }, select: { source: true } });
    expect(sources.every((item) => item.source === 'agent')).toBe(true);
  });

  it('ChangeLog 失败时 create 与 update 都整笔回滚', async () => {
    const student = await prisma.student.create({ data: { teacherId, name: '学生', grade: '高一' } });
    const failingChangelogFactory = () => ({
      recordChange: async () => ({ ok: false }) as never,
    });
    const failingService = createCommunicationService({
      getClient: async () => prisma,
      cipher,
      changelogFactory: failingChangelogFactory,
    });
    const failedCreate = await failingService.createCommunicationRecord({
      teacherId, studentId: student.id, summary: '不会提交', direction: 'inbound',
      parentConcerns: ['不会提交'],
    });
    expect(failedCreate.ok).toBe(false);
    expect(await prisma.studentRecord.count({ where: { teacherId } })).toBe(0);
    expect(await prisma.communicationDetail.count({ where: { teacherId } })).toBe(0);

    const normalService = createCommunicationService({ getClient: async () => prisma, cipher });
    const created = await normalService.createCommunicationRecord({
      teacherId, studentId: student.id, summary: '原摘要', direction: 'inbound',
      parentConcerns: ['原诉求'],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const logCount = await prisma.changeLog.count({ where: { teacherId } });
    const failedUpdate = await failingService.updateDetail({
      teacherId, studentId: student.id, recordId: created.value.record.id,
      patch: { parentConcerns: ['不能提交的新诉求'] },
    });
    expect(failedUpdate.ok).toBe(false);
    const persisted = await normalService.getOwnedDetail({
      teacherId, studentId: student.id, recordId: created.value.record.id,
    });
    expect(persisted.ok && persisted.value.parentConcerns).toEqual(['原诉求']);
    expect(await prisma.changeLog.count({ where: { teacherId } })).toBe(logCount);
  });

  it('TrustedClock 返回旧 token 时文本、审核投影与 ChangeLog 均零写', async () => {
    const student = await prisma.student.create({ data: { teacherId, name: '学生', grade: '高一' } });
    const normalService = createCommunicationService({ getClient: async () => prisma, cipher });
    const created = await normalService.createCommunicationRecord({
      teacherId, studentId: student.id, summary: '摘要', direction: 'inbound',
      parentConcerns: ['旧诉求'],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const beforeLogs = await prisma.changeLog.count({ where: { teacherId } });
    const sameTokenService = createCommunicationService({
      getClient: async () => prisma,
      cipher,
      trustedClockFactory: () => ({
        now: async () => ({ ok: true, value: created.value.detail.updatedAtTs } as const),
      }),
    });
    const result = await sameTokenService.updateDetail({
      teacherId, studentId: student.id, recordId: created.value.record.id,
      patch: { parentConcerns: ['不得提交的新诉求'] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INTERNAL_ERROR');
    const persisted = await normalService.getOwnedDetail({
      teacherId, studentId: student.id, recordId: created.value.record.id,
    });
    expect(persisted.ok && persisted.value.parentConcerns).toEqual(['旧诉求']);
    expect(persisted.ok && persisted.value.moderationFlagged).toBeNull();
    expect(persisted.ok && persisted.value.moderationReasons).toBeNull();
    expect(await prisma.changeLog.count({ where: { teacherId } })).toBe(beforeLogs);
  });

  it('并发文本 PATCH 仅一方成功，失败方不写 ChangeLog', async () => {
    const student = await prisma.student.create({ data: { teacherId, name: '学生', grade: '高一' } });
    const baseService = createCommunicationService({ getClient: async () => prisma, cipher });
    const created = await baseService.createCommunicationRecord({
      teacherId, studentId: student.id, summary: '摘要', direction: 'inbound',
      parentConcerns: ['旧诉求'],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    let calls = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const moderateText = vi.fn(async () => {
      calls += 1;
      if (calls === 2) release();
      await barrier;
      return { verdict: 'pass' as const, labels: [], flagged: false, reasons: [] };
    });
    const service = createCommunicationService({
      getClient: async () => prisma,
      cipher,
      moderation: { provider: 'local', moderateText },
    });
    const beforeLogs = await prisma.changeLog.count({ where: { teacherId } });
    const results = await Promise.all([
      service.updateDetail({
        teacherId, studentId: student.id, recordId: created.value.record.id,
        patch: { parentConcerns: ['并发一'] },
      }),
      service.updateDetail({
        teacherId, studentId: student.id, recordId: created.value.record.id,
        patch: { parentConcerns: ['并发二'] },
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const failed = results.find((result) => !result.ok);
    expect(failed && !failed.ok && failed.error.code).toBe('VERSION_CONFLICT');
    expect(await prisma.changeLog.count({ where: { teacherId } })).toBe(beforeLogs + 1);
  });

  it('owner 校验失败在解密和 moderation 前返回 NOT_FOUND/零调用', async () => {
    const student = await prisma.student.create({ data: { teacherId, name: '学生', grade: '高一' } });
    const moderateText = vi.fn();
    const service = createCommunicationService({
      getClient: async () => prisma, cipher, moderation: { provider: 'local', moderateText },
    });
    const result = await service.createCommunicationRecord({
      teacherId: otherTeacherId, studentId: student.id, summary: '摘要', direction: 'inbound',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
    expect(moderateText).not.toHaveBeenCalled();
  });
});
