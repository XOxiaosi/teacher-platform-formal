export const REQUIREMENT_CATEGORIES = [
  'feature',
  'improvement',
  'bug_report',
  'ux',
  'performance',
  'privacy',
  'other',
] as const;

export const REQUIREMENT_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const REQUIREMENT_STATUSES = ['new', 'triaged', 'in_progress', 'done', 'archived'] as const;

export type RequirementCategory = (typeof REQUIREMENT_CATEGORIES)[number];
export type RequirementPriority = (typeof REQUIREMENT_PRIORITIES)[number];
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];
