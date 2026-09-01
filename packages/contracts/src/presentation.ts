export type PresentationObjectType =
  | 'Student'
  | 'Schedule'
  | 'Lesson'
  | 'Payment'
  | 'Memo'
  | 'ParentFeedback';

export interface PresentationTextSection {
  id: string;
  kind: 'text';
  heading?: string;
  text: string;
}

export interface PresentationFactsSection {
  id: string;
  kind: 'facts';
  heading?: string;
  items: Array<{
    label: string;
    value: string;
  }>;
}

export interface PresentationListSection {
  id: string;
  kind: 'list';
  heading?: string;
  items: Array<{
    id: string;
    label: string;
    detail?: string;
    referenceId?: string;
  }>;
}

export type PresentationSection =
  | PresentationTextSection
  | PresentationFactsSection
  | PresentationListSection;

export interface ObjectReference {
  id: string;
  type: PresentationObjectType;
  objectId: string;
  label: string;
  studentId?: string;
}

export interface PresentationAction {
  id: string;
  kind: 'open-reference';
  label: string;
  referenceId: string;
}

export interface PresentationDocument {
  schemaVersion: 1;
  title?: string;
  summary: string;
  sections: PresentationSection[];
  references: ObjectReference[];
  actions: PresentationAction[];
}
