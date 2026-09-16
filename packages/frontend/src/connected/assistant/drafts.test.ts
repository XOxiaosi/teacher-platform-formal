import { beforeEach, describe, expect, it } from 'vitest';
import { clearAssistantDrafts, readDraft, writeDraft } from './drafts';

describe('assistant draft account isolation', () => {
  beforeEach(() => sessionStorage.clear());

  it('clears the logged-out account while retaining another account draft', () => {
    writeDraft('teacher-a', 'conversation-a', { text: '甲的未发送内容', requestId: 'request-a' });
    writeDraft('teacher-b', 'conversation-b', { text: '乙的未发送内容', requestId: 'request-b' });
    clearAssistantDrafts('teacher-a');
    expect(readDraft('teacher-a', 'conversation-a').text).toBe('');
    expect(readDraft('teacher-b', 'conversation-b')).toEqual({ text: '乙的未发送内容', requestId: 'request-b' });
  });
});
