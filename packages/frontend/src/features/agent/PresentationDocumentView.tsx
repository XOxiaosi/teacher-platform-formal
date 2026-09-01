import type { MouseEvent } from 'react';
import type {
  ObjectReference,
  PresentationDocument,
  PresentationSection,
} from '@teacher-platform/contracts';
import {
  getPresentationActionRoute,
  getPresentationReferenceRoute,
} from './presentation-routing';

interface PresentationDocumentViewProps {
  document: PresentationDocument;
  onNavigate?: (path: string) => void;
}

function follow(
  event: MouseEvent<HTMLAnchorElement>,
  path: string,
  onNavigate?: (path: string) => void,
) {
  if (!onNavigate) return;
  event.preventDefault();
  onNavigate(path);
}

function SectionView({ section }: { section: PresentationSection }) {
  if (section.kind === 'text') {
    return (
      <section className="presentation-section presentation-section--text">
        {section.heading && <h4>{section.heading}</h4>}
        <p>{section.text}</p>
      </section>
    );
  }

  if (section.kind === 'facts') {
    return (
      <section className="presentation-section presentation-section--facts">
        {section.heading && <h4>{section.heading}</h4>}
        <dl aria-label={section.heading ?? '事实信息'}>
          {section.items.map((item, index) => (
            <div key={`${item.label}:${index}`}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      </section>
    );
  }

  return (
    <section className="presentation-section presentation-section--list">
      {section.heading && <h4>{section.heading}</h4>}
      <ul aria-label={section.heading ?? '列表'}>
        {section.items.map((item) => (
          <li key={item.id}>
            <strong>{item.label}</strong>
            {item.detail && <span>{item.detail}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReferenceItem({
  reference,
  onNavigate,
}: {
  reference: ObjectReference;
  onNavigate?: (path: string) => void;
}) {
  const route = getPresentationReferenceRoute(reference);
  if (!route) return <span>{reference.label}</span>;
  return (
    <a href={route} onClick={(event) => follow(event, route, onNavigate)}>
      {reference.label}
    </a>
  );
}

export function PresentationDocumentView({
  document,
  onNavigate,
}: PresentationDocumentViewProps) {
  const accessibleName = document.title ?? document.summary;
  return (
    <article className="turn presentation-document" aria-label={accessibleName}>
      <span className="turn-kind">Agent</span>
      {document.title && <h3>{document.title}</h3>}
      <p className="presentation-summary">{document.summary}</p>

      {document.sections.map((section) => (
        <SectionView key={section.id} section={section} />
      ))}

      {document.references.length > 0 && (
        <div className="presentation-references" aria-label="关联对象">
          <span>关联对象</span>
          <div>
            {document.references.map((reference) => (
              <ReferenceItem
                key={reference.id}
                reference={reference}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </div>
      )}

      {document.actions.length > 0 && (
        <nav className="presentation-actions" aria-label="结果操作">
          {document.actions.map((action) => {
            const route = getPresentationActionRoute(action, document.references);
            return route ? (
              <a
                key={action.id}
                href={route}
                onClick={(event) => follow(event, route, onNavigate)}
              >
                {action.label}
              </a>
            ) : null;
          })}
        </nav>
      )}
    </article>
  );
}
