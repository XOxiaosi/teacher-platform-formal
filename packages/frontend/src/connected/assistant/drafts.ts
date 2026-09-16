export interface AssistantDraft { text: string; requestId: string }
const prefix = 'teaching-assistant-draft:';
const key = (teacherId: string, conversationId: string) => `${prefix}${encodeURIComponent(teacherId)}:${encodeURIComponent(conversationId)}`;
const memory = new Map<string, AssistantDraft>();
export function readDraft(teacherId: string, conversationId: string): AssistantDraft {
  const id = key(teacherId, conversationId);
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(id) ?? 'null');
    if (raw && typeof raw === 'object' && 'text' in raw && typeof raw.text === 'string' && 'requestId' in raw && typeof raw.requestId === 'string') return raw as AssistantDraft;
  } catch { /* Storage may be disabled; the open page can still retain the draft. */ }
  return memory.get(id) ?? { text: '', requestId: crypto.randomUUID() };
}
export function writeDraft(teacherId: string, conversationId: string, draft: AssistantDraft): void {
  const id = key(teacherId, conversationId);
  memory.set(id, draft);
  try { sessionStorage.setItem(id, JSON.stringify(draft)); } catch { /* Memory fallback, never localStorage. */ }
}
/** Call when the authenticated teacher logs out. */
export function clearAssistantDrafts(teacherId: string): void {
  const accountPrefix = `${prefix}${encodeURIComponent(teacherId)}:`;
  for (const id of memory.keys()) if (id.startsWith(accountPrefix)) memory.delete(id);
  try {
    for (const id of Object.keys(sessionStorage)) if (id.startsWith(accountPrefix)) sessionStorage.removeItem(id);
  } catch { /* No accessible stored drafts. */ }
}
export function retainOnlyTeacherDrafts(teacherId: string): void {
  const accountPrefix = `${prefix}${encodeURIComponent(teacherId)}:`;
  for (const id of memory.keys()) if (id.startsWith(prefix) && !id.startsWith(accountPrefix)) memory.delete(id);
  try {
    for (const id of Object.keys(sessionStorage)) if (id.startsWith(prefix) && !id.startsWith(accountPrefix)) sessionStorage.removeItem(id);
  } catch { /* No accessible stored drafts. */ }
}
