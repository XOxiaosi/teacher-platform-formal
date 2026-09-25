import type { Course, Studio } from './model';

export type ChangeState = 'pending' | 'done' | 'cancelled' | 'superseded' | 'failed';
export type ChatCard =
  | { kind: 'schedule'; courses: Course[] }
  | { kind: 'student'; studentId: string }
  | { kind: 'review'; studentId: string; courseId?: string; candidateIds: string[] }
  | { kind: 'feedback'; studentId: string; courseId?: string; occurredOn: string; text: string; sourceIds: string[]; state: 'draft' | 'saved' | 'superseded' }
  | { kind: 'course-change'; before: Course | null; after: Course; state: ChangeState }
  | { kind: 'complete'; course: Course; attendance: {studentId: string; attended: boolean; amount: number; before: number}[]; state: ChangeState };
export type ChatMessage = { id: string; role: 'user' | 'assistant'; text: string; card?: ChatCard };
export type Conversation = { id: string; title: string; messages: ChatMessage[]; archived: boolean; input: string; context: {studentId?: string; courseId?: string; followUp?: 'feedback'} };
export type ChatState = { activeId: string; conversations: Conversation[] };
export type Workspace = { data: Studio; chat: ChatState };
export type ChatAction =
  | {kind: 'confirm-change'}
  | {kind: 'cancel-change'}
  | {kind: 'review-candidate'; candidateId: string; text: string; speaker: string; share: boolean; decision: 'confirmed' | 'rejected'}
  | {kind: 'edit-feedback'; text: string}
  | {kind: 'save-feedback'}
  | {kind: 'edit-attendance'; studentId: string; attended: boolean; amount: number};
