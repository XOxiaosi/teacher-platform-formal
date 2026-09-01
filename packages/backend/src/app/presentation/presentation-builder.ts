import type {
  ObjectReference,
  PresentationAction,
  PresentationDocument,
  PresentationSection,
} from '@teacher-platform/contracts';
import {
  presentToolResult,
  type PresentationToolResult,
} from './tool-result-presenters.js';

const MAX_SUMMARY_LENGTH = 4_000;
const MAX_SECTIONS = 12;
const MAX_REFERENCES = 50;
const MAX_ACTIONS = 50;
const FALLBACK_SUMMARY = '已完成处理。';

export interface BuildPresentationInput {
  summary: string;
  toolResults: readonly PresentationToolResult[];
}

export interface PresentationBuilder {
  build(input: BuildPresentationInput): PresentationDocument;
}

function normalizedSummary(value: string): string {
  const trimmed = value.trim();
  return (trimmed || FALLBACK_SUMMARY).slice(0, MAX_SUMMARY_LENGTH);
}

function uniqueById<T extends { id: string }>(values: readonly T[], limit: number): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    if (seen.has(value.id)) continue;
    seen.add(value.id);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

function withoutMissingReferences(
  sections: readonly PresentationSection[],
  referenceIds: ReadonlySet<string>,
): PresentationSection[] {
  return sections.map((section) => {
    if (section.kind !== 'list') return section;
    return {
      ...section,
      items: section.items.map((item) => (
        item.referenceId && !referenceIds.has(item.referenceId)
          ? { id: item.id, label: item.label, ...(item.detail ? { detail: item.detail } : {}) }
          : item
      )),
    };
  });
}

function actionsFor(references: readonly ObjectReference[]): PresentationAction[] {
  return references.slice(0, MAX_ACTIONS).map((reference, index) => {
    const preferredId = `open:${reference.id}`;
    return {
      id: preferredId.length <= 128 ? preferredId : `open-reference:${index}`,
      kind: 'open-reference',
      label: `查看${reference.label}`.slice(0, 120),
      referenceId: reference.id,
    };
  });
}

export function createPresentationBuilder(): PresentationBuilder {
  return {
    build(input) {
      const fragments = input.toolResults.map(presentToolResult);
      const references = uniqueById(
        fragments.flatMap((fragment) => fragment.references),
        MAX_REFERENCES,
      );
      const referenceIds = new Set(references.map((reference) => reference.id));
      const sections = withoutMissingReferences(
        uniqueById(
          fragments.flatMap((fragment) => fragment.sections),
          MAX_SECTIONS,
        ),
        referenceIds,
      );

      return {
        schemaVersion: 1,
        summary: normalizedSummary(input.summary),
        sections,
        references,
        actions: actionsFor(references),
      };
    },
  };
}
