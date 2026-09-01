import type { MouseEvent } from 'react';
import type { ObjectReferenceDto } from '../../api/conversations';

interface ObjectReferenceLinksProps {
  references: ObjectReferenceDto[];
  onNavigate?: (path: string) => void;
}

export function ObjectReferenceLinks({ references, onNavigate }: ObjectReferenceLinksProps) {
  if (references.length === 0) return null;

  function follow(event: MouseEvent<HTMLAnchorElement>, route: string) {
    if (!onNavigate) return;
    event.preventDefault();
    onNavigate(route);
  }

  return (
    <div className="object-references" aria-label="关联对象">
      {references.map((reference) => (
        <a
          key={`${reference.type}:${reference.id}`}
          href={reference.route}
          onClick={(event) => follow(event, reference.route)}
        >{reference.label}</a>
      ))}
    </div>
  );
}
