/**
 * Stable edit command metadata shared by Web, Agent and future channel adapters.
 * teacherId and source are injected by trusted application boundaries.
 */
export type EditCommandSource =
  | 'manual-web'
  | 'agent-confirmed'
  | 'wechat-confirmed'
  | 'system';

export interface EditCommandMeta {
  teacherId: string;
  expectedUpdatedAt?: string;
  source: EditCommandSource;
}
