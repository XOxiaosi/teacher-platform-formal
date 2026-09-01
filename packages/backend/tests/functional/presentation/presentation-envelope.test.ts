import { describe, expect, it } from 'vitest';
import {
  buildFallbackPresentation,
  createAssistantPresentationEnvelope,
  readAssistantPresentationEnvelope,
} from '../../../src/app/presentation/index.js';

function validDocument() {
  return {
    schemaVersion: 1,
    title: '学生信息',
    summary: '已找到张三。',
    sections: [{
      id: 'student-facts',
      kind: 'facts',
      heading: '基本信息',
      items: [{ label: '年级', value: '高三' }],
    }],
    references: [{ id: 'Student:student-1', type: 'Student', objectId: 'student-1', label: '张三' }],
    actions: [{
      id: 'open:Student:student-1',
      kind: 'open-reference',
      label: '查看张三',
      referenceId: 'Student:student-1',
    }],
  };
}

describe('Assistant presentation envelope', () => {
  it('V1信封可往返且不改变文档', () => {
    const document = validDocument();
    const envelope = createAssistantPresentationEnvelope(document);

    expect(envelope).toEqual({
      kind: 'assistant-presentation',
      version: 1,
      document,
    });
    expect(readAssistantPresentationEnvelope(envelope)).toEqual(document);
  });

  it.each([
    null,
    {},
    { kind: 'assistant-presentation', version: 2, document: validDocument() },
    { kind: 'assistant-presentation', version: 1, document: { ...validDocument(), summary: '' } },
    { kind: 'assistant-presentation', version: 1, document: { ...validDocument(), summary: '   ' } },
    { kind: 'assistant-presentation', version: 1, document: { ...validDocument(), summary: '甲'.repeat(4001) } },
    { kind: 'assistant-presentation', version: 1, document: { ...validDocument(), route: '/unsafe' } },
    { kind: 'assistant-presentation', version: 1, document: {
      ...validDocument(),
      actions: [{ id: 'bad', kind: 'open-reference', label: '坏动作', referenceId: 'missing' }],
    } },
  ])('非法、越界、未知版本或悬空动作整体拒绝：%j', (value) => {
    expect(readAssistantPresentationEnvelope(value)).toBeNull();
  });

  it('历史Assistant内容生成最小fallback且执行相同长度边界', () => {
    expect(buildFallbackPresentation('  历史回复  ')).toEqual({
      schemaVersion: 1,
      summary: '历史回复',
      sections: [],
      references: [],
      actions: [],
    });
    expect(buildFallbackPresentation('乙'.repeat(4100)).summary).toHaveLength(4000);
  });
});
