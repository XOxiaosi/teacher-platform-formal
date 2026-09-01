import type {
  ObjectReference,
  PresentationFactsSection,
  PresentationListSection,
  PresentationSection,
} from '@teacher-platform/contracts';

const MAX_ITEMS = 50;
const MAX_ID_LENGTH = 128;
const MAX_LABEL_LENGTH = 120;
const MAX_CONTENT_LENGTH = 4_000;

export interface PresentationToolResult {
  toolCallId: string;
  toolName: string;
  value: unknown;
}

export interface ToolPresentationFragment {
  sections: PresentationSection[];
  references: ObjectReference[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function stableId(value: unknown, prefix = ''): string | null {
  const id = boundedText(value, MAX_ID_LENGTH);
  if (!id) return null;
  const composed = `${prefix}${id}`;
  return composed.length <= MAX_ID_LENGTH ? composed : null;
}

function derivedId(...parts: Array<string | number>): string | null {
  const id = parts.join(':');
  return id.length <= MAX_ID_LENGTH ? id : null;
}

function sectionId(toolName: string, toolCallId: string, suffix: 'facts' | 'list'): string | null {
  return derivedId(toolName, toolCallId, suffix);
}

function studentReference(id: string, name: string): ObjectReference | null {
  const referenceId = stableId(id, 'Student:');
  if (!referenceId) return null;
  return {
    id: referenceId,
    type: 'Student',
    objectId: id,
    label: name,
  };
}

function scheduleReference(id: string, title: string): ObjectReference | null {
  const referenceId = stableId(id, 'Schedule:');
  if (!referenceId) return null;
  return {
    id: referenceId,
    type: 'Schedule',
    objectId: id,
    label: title,
  };
}

function fact(label: string, value: unknown): { label: string; value: string } | null {
  const text = boundedText(value, MAX_CONTENT_LENGTH);
  return text ? { label, value: text } : null;
}

function compact<T>(values: Array<T | null>): T[] {
  return values.filter((value): value is T => value !== null);
}

function instant(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function studentFacts(input: PresentationToolResult): ToolPresentationFragment {
  if (!isRecord(input.value)) return { sections: [], references: [] };
  const id = boundedText(input.value.id, MAX_ID_LENGTH);
  const name = boundedText(input.value.name, MAX_LABEL_LENGTH);
  if (!id || !name) return { sections: [], references: [] };
  const reference = studentReference(id, name);
  const idForSection = sectionId(input.toolName, input.toolCallId, 'facts');
  if (!reference || !idForSection) return { sections: [], references: [] };
  const items = compact([
    fact('姓名', name),
    fact('年级', input.value.grade),
    fact('状态', input.value.currentStatus),
    fact('阶段目标', input.value.stageGoal),
  ]);
  const section: PresentationFactsSection = {
    id: idForSection,
    kind: 'facts',
    heading: '学生信息',
    items,
  };
  return { sections: [section], references: [reference] };
}

function studentList(input: PresentationToolResult): ToolPresentationFragment {
  if (!isRecord(input.value) || !Array.isArray(input.value.items)) {
    return { sections: [], references: [] };
  }
  const idForSection = sectionId(input.toolName, input.toolCallId, 'list');
  if (!idForSection) return { sections: [], references: [] };
  const references: ObjectReference[] = [];
  const items = input.value.items.slice(0, MAX_ITEMS).flatMap((value, index) => {
    if (!isRecord(value)) return [];
    const id = boundedText(value.id, MAX_ID_LENGTH);
    const name = boundedText(value.name, MAX_LABEL_LENGTH);
    const idForItem = derivedId(input.toolName, input.toolCallId, 'item', index);
    if (!id || !name || !idForItem) return [];
    const reference = studentReference(id, name);
    if (!reference) return [];
    references.push(reference);
    const detail = compact([
      boundedText(value.grade, MAX_LABEL_LENGTH),
      boundedText(value.currentStatus, MAX_LABEL_LENGTH),
    ]).join(' · ');
    return [{
      id: idForItem,
      label: name,
      ...(detail ? { detail } : {}),
      referenceId: reference.id,
    }];
  });
  if (items.length === 0) return { sections: [], references: [] };
  const section: PresentationListSection = {
    id: idForSection,
    kind: 'list',
    heading: '学生列表',
    items,
  };
  return { sections: [section], references };
}

function scheduleFacts(input: PresentationToolResult): ToolPresentationFragment {
  if (!isRecord(input.value) || !isRecord(input.value.schedule)) {
    return { sections: [], references: [] };
  }
  const schedule = input.value.schedule;
  const id = boundedText(schedule.id, MAX_ID_LENGTH);
  const title = boundedText(schedule.title, MAX_LABEL_LENGTH);
  if (!id || !title) return { sections: [], references: [] };
  const reference = scheduleReference(id, title);
  const idForSection = sectionId(input.toolName, input.toolCallId, 'facts');
  if (!reference || !idForSection) return { sections: [], references: [] };
  const items = compact([
    fact('标题', title),
    fact('开始', instant(schedule.scheduledStart)),
    fact('结束', instant(schedule.scheduledEnd)),
    fact('状态', schedule.status),
  ]);
  const section: PresentationFactsSection = {
    id: idForSection,
    kind: 'facts',
    heading: '日程信息',
    items,
  };
  return { sections: [section], references: [reference] };
}

function scheduleList(input: PresentationToolResult): ToolPresentationFragment {
  if (!isRecord(input.value) || !Array.isArray(input.value.items)) {
    return { sections: [], references: [] };
  }
  const idForSection = sectionId(input.toolName, input.toolCallId, 'list');
  if (!idForSection) return { sections: [], references: [] };
  const references: ObjectReference[] = [];
  const items = input.value.items.slice(0, MAX_ITEMS).flatMap((value, index) => {
    if (!isRecord(value)) return [];
    const id = boundedText(value.id, MAX_ID_LENGTH);
    const title = boundedText(value.title, MAX_LABEL_LENGTH);
    const idForItem = derivedId(input.toolName, input.toolCallId, 'item', index);
    if (!id || !title || !idForItem) return [];
    const reference = scheduleReference(id, title);
    if (!reference) return [];
    references.push(reference);
    const start = instant(value.scheduledStart);
    const end = instant(value.scheduledEnd);
    const status = boundedText(value.status, MAX_LABEL_LENGTH);
    const time = start && end ? `${start} 至 ${end}` : start ?? end;
    const detail = compact([time, status]).join(' · ');
    return [{
      id: idForItem,
      label: title,
      ...(detail ? { detail } : {}),
      referenceId: reference.id,
    }];
  });
  if (items.length === 0) return { sections: [], references: [] };
  const section: PresentationListSection = {
    id: idForSection,
    kind: 'list',
    heading: '日程列表',
    items,
  };
  return { sections: [section], references };
}

export function presentToolResult(input: PresentationToolResult): ToolPresentationFragment {
  if (input.toolName === 'students.get' || input.toolName === 'students.create') {
    return studentFacts(input);
  }
  if (input.toolName === 'students.list') return studentList(input);
  if (input.toolName === 'scheduling.create') return scheduleFacts(input);
  if (input.toolName === 'scheduling.list') return scheduleList(input);
  return { sections: [], references: [] };
}
