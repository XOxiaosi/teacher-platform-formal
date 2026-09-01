import type { Ref } from 'react';
import type { AgendaItem, ObjectReference } from '@teacher-platform/contracts';
import { getPresentationActionRoute } from '../object-reference-routing';
import { formatAgendaTime, formatAgendaTimeRange } from './agenda-time';
import { agendaStatusLabel } from './agenda-view-model';
import './agenda.css';

interface AgendaItemViewProps {
  item: AgendaItem;
  onNavigate: (path: string) => void;
  focused?: boolean;
  elementRef?: Ref<HTMLElement>;
}

function itemTimeLabel(item: AgendaItem): string | null {
  if (item.kind === 'lesson') {
    return formatAgendaTimeRange(item.startAt, item.endAt) ?? '时间不可用';
  }
  if (!item.startAt) return null;
  const time = formatAgendaTime(item.startAt);
  if (!time) return '时间不可用';
  if (item.kind === 'pending_action') return `确认截止 ${time}`;
  if (item.kind === 'memo') return `到期 ${time}`;
  return time;
}

export function AgendaItemView({
  item,
  onNavigate,
  focused = false,
  elementRef,
}: AgendaItemViewProps) {
  const references: ObjectReference[] = [
    item.sourceRef,
    ...(item.studentRef ? [item.studentRef] : []),
  ];
  const actions = item.actions.flatMap((action) => {
    const route = getPresentationActionRoute(action, references);
    return route ? [{ action, route }] : [];
  });
  const timeLabel = itemTimeLabel(item);

  return (
    <article
      ref={elementRef}
      className={`agenda-item agenda-item--${item.kind}${focused ? ' agenda-item--focused' : ''}`}
      aria-current={focused ? 'true' : undefined}
    >
      <div className="agenda-item__body">
        {timeLabel ? (
          <time
            className="agenda-item__time"
            dateTime={item.startAt}
            data-end-at={item.endAt}
          >
            {timeLabel}
          </time>
        ) : null}
        <strong className="agenda-item__title">{item.title}</strong>
        {item.studentRef ? <span className="agenda-item__student">{item.studentRef.label}</span> : null}
      </div>
      <div className="agenda-item__meta">
        <span className="agenda-item__status">{agendaStatusLabel(item.status)}</span>
        {actions.length > 0 ? (
          <nav className="agenda-item__actions" aria-label={`${item.title}操作`}>
            {actions.map(({ action, route }) => (
              <a
                key={action.id}
                href={route}
                onClick={(event) => {
                  event.preventDefault();
                  onNavigate(route);
                }}
              >
                {action.label}
              </a>
            ))}
          </nav>
        ) : null}
      </div>
    </article>
  );
}
