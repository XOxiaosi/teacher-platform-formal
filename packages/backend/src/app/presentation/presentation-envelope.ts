import type {
  ObjectReference,
  PresentationAction,
  PresentationDocument,
  PresentationSection,
} from '@teacher-platform/contracts';

const MAX_SUMMARY_LENGTH = 4_000;
const MAX_TITLE_LENGTH = 80;
const MAX_SECTIONS = 12;
const MAX_ITEMS = 50;
const MAX_REFERENCES = 50;
const MAX_ACTIONS = 50;
const MAX_ID_LENGTH = 128;
const MAX_LABEL_LENGTH = 120;
const MAX_CONTENT_LENGTH = 4_000;
const FALLBACK_SUMMARY = '已完成处理。';

export interface AssistantPresentationEnvelopeV1 {
  kind: 'assistant-presentation';
  version: 1;
  document: PresentationDocument;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maxLength;
}

function isOptionalBoundedString(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined || isBoundedString(value, maxLength);
}

function hasUniqueIds(values: readonly { id: string }[]): boolean {
  return new Set(values.map((value) => value.id)).size === values.length;
}

function isFactsItem(value: unknown): value is { label: string; value: string } {
  return isRecord(value)
    && hasExactKeys(value, ['label', 'value'])
    && isBoundedString(value.label, MAX_LABEL_LENGTH)
    && isBoundedString(value.value, MAX_CONTENT_LENGTH);
}

function isListItem(value: unknown): value is {
  id: string;
  label: string;
  detail?: string;
  referenceId?: string;
} {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'label'], ['detail', 'referenceId'])
    && isBoundedString(value.id, MAX_ID_LENGTH)
    && isBoundedString(value.label, MAX_LABEL_LENGTH)
    && isOptionalBoundedString(value.detail, MAX_CONTENT_LENGTH)
    && isOptionalBoundedString(value.referenceId, MAX_ID_LENGTH);
}

function isSection(value: unknown): value is PresentationSection {
  if (!isRecord(value) || !isBoundedString(value.id, MAX_ID_LENGTH)) return false;
  if (!isOptionalBoundedString(value.heading, MAX_LABEL_LENGTH)) return false;

  if (value.kind === 'text') {
    return hasExactKeys(value, ['id', 'kind', 'text'], ['heading'])
      && isBoundedString(value.text, MAX_CONTENT_LENGTH);
  }

  if (value.kind === 'facts') {
    return hasExactKeys(value, ['id', 'kind', 'items'], ['heading'])
      && Array.isArray(value.items)
      && value.items.length <= MAX_ITEMS
      && value.items.every(isFactsItem);
  }

  if (value.kind === 'list') {
    return hasExactKeys(value, ['id', 'kind', 'items'], ['heading'])
      && Array.isArray(value.items)
      && value.items.length <= MAX_ITEMS
      && value.items.every(isListItem)
      && hasUniqueIds(value.items);
  }

  return false;
}

function isReference(value: unknown): value is ObjectReference {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'type', 'objectId', 'label'], ['studentId'])
    && isBoundedString(value.id, MAX_ID_LENGTH)
    && (
      value.type === 'Student'
      || value.type === 'Schedule'
      || value.type === 'Lesson'
      || value.type === 'Payment'
      || value.type === 'Memo'
      || value.type === 'ParentFeedback'
    )
    && isBoundedString(value.objectId, MAX_ID_LENGTH)
    && isBoundedString(value.label, MAX_LABEL_LENGTH)
    && isOptionalBoundedString(value.studentId, MAX_ID_LENGTH);
}

function isAction(value: unknown): value is PresentationAction {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'kind', 'label', 'referenceId'])
    && isBoundedString(value.id, MAX_ID_LENGTH)
    && value.kind === 'open-reference'
    && isBoundedString(value.label, MAX_LABEL_LENGTH)
    && isBoundedString(value.referenceId, MAX_ID_LENGTH);
}

function isPresentationDocument(value: unknown): value is PresentationDocument {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(
    value,
    ['schemaVersion', 'summary', 'sections', 'references', 'actions'],
    ['title'],
  )) return false;
  if (value.schemaVersion !== 1) return false;
  if (!isOptionalBoundedString(value.title, MAX_TITLE_LENGTH)) return false;
  if (!isBoundedString(value.summary, MAX_SUMMARY_LENGTH)) return false;
  if (!Array.isArray(value.sections) || value.sections.length > MAX_SECTIONS) return false;
  if (!Array.isArray(value.references) || value.references.length > MAX_REFERENCES) return false;
  if (!Array.isArray(value.actions) || value.actions.length > MAX_ACTIONS) return false;
  if (!value.sections.every(isSection) || !hasUniqueIds(value.sections)) return false;
  if (!value.references.every(isReference) || !hasUniqueIds(value.references)) return false;
  if (!value.actions.every(isAction) || !hasUniqueIds(value.actions)) return false;

  const referenceIds = new Set(value.references.map((reference) => reference.id));
  if (!value.actions.every((action) => referenceIds.has(action.referenceId))) return false;
  for (const section of value.sections) {
    if (section.kind !== 'list') continue;
    if (!section.items.every((item) => item.referenceId === undefined || referenceIds.has(item.referenceId))) {
      return false;
    }
  }
  return true;
}

function normalizedSummary(value: string): string {
  const trimmed = value.trim();
  return (trimmed || FALLBACK_SUMMARY).slice(0, MAX_SUMMARY_LENGTH);
}

export function buildFallbackPresentation(content: string): PresentationDocument {
  return {
    schemaVersion: 1,
    summary: normalizedSummary(content),
    sections: [],
    references: [],
    actions: [],
  };
}

export function createAssistantPresentationEnvelope(
  document: PresentationDocument,
): AssistantPresentationEnvelopeV1 {
  return {
    kind: 'assistant-presentation',
    version: 1,
    document,
  };
}

export function readAssistantPresentationEnvelope(value: unknown): PresentationDocument | null {
  if (!isRecord(value)) return null;
  if (!hasExactKeys(value, ['kind', 'version', 'document'])) return null;
  if (value.kind !== 'assistant-presentation' || value.version !== 1) return null;
  return isPresentationDocument(value.document) ? value.document : null;
}
