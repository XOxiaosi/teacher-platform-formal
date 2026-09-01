import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { RefObject } from 'react';
import type { AgendaItem, AgendaTodayDocument } from '@teacher-platform/contracts';
import { agendaApi } from '../../api/agenda';
import { AgendaItemView } from '../../shared/agenda/AgendaItemView';
import { formatAgendaTime, formatBusinessDate } from '../../shared/agenda/agenda-time';
import {
  groupTodayAgenda,
  summarizeTodayAgenda,
} from '../../shared/agenda/agenda-view-model';
import './dashboard.css';

interface DashboardPageProps {
  teacherId: string;
  onNavigate: (path: string) => void;
  focusMemo?: string;
}

type LoadMode = 'initial' | 'refresh';

export function DashboardPage({ teacherId, onNavigate, focusMemo }: DashboardPageProps) {
  const [document, setDocument] = useState<AgendaTodayDocument | null>(null);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const requestGeneration = useRef(0);
  const pendingGeneration = useRef<number | null>(null);
  const focusedMemoRef = useRef<HTMLElement>(null);

  const loadAgenda = useCallback((mode: LoadMode) => {
    if (pendingGeneration.current !== null) return;
    const generation = ++requestGeneration.current;
    pendingGeneration.current = generation;

    if (mode === 'initial') {
      setDocument(null);
      setInitialError(null);
      setRefreshError(null);
      setRefreshing(false);
    } else {
      setRefreshError(null);
      setRefreshing(true);
    }

    void agendaApi.getToday(teacherId)
      .then((nextDocument) => {
        if (requestGeneration.current !== generation) return;
        setDocument(nextDocument);
        setInitialError(null);
        setRefreshError(null);
      })
      .catch((error: unknown) => {
        if (requestGeneration.current !== generation) return;
        const message = messageOf(error);
        if (mode === 'refresh') setRefreshError(message);
        else setInitialError(message);
      })
      .finally(() => {
        if (requestGeneration.current !== generation) return;
        pendingGeneration.current = null;
        if (mode === 'refresh') setRefreshing(false);
      });
  }, [teacherId]);

  useEffect(() => {
    loadAgenda('initial');
    return () => {
      requestGeneration.current += 1;
      pendingGeneration.current = null;
    };
  }, [loadAgenda]);

  const groups = useMemo(
    () => document ? groupTodayAgenda(document.items) : null,
    [document],
  );
  const hasFocusedMemo = Boolean(
    focusMemo
    && groups?.memos.some((item) => item.sourceRef.objectId === focusMemo),
  );

  useEffect(() => {
    if (hasFocusedMemo) focusedMemoRef.current?.scrollIntoView({ block: 'center' });
  }, [document, focusMemo, hasFocusedMemo]);

  if (!document && initialError) {
    return (
      <section className="page-card today-load-state today-load-state--error" role="alert">
        <p className="eyebrow">Today</p>
        <h2>今日安排加载失败</h2>
        <p>{initialError}</p>
        <button className="today-secondary-button" type="button" onClick={() => loadAgenda('initial')}>
          重试
        </button>
      </section>
    );
  }

  if (!document || !groups) {
    return <section className="page-card today-load-state" aria-live="polite">正在加载今日安排</section>;
  }

  return (
    <section className="today-page" aria-labelledby="today-page-heading">
      <header className="page-card today-header">
        <div>
          <p className="eyebrow">今日安排</p>
          <h2 id="today-page-heading">{safeBusinessDateLabel(document.businessDate)}</h2>
          <p className="today-summary">{summarizeTodayAgenda(groups)}</p>
          <p className="today-generated-at">{generatedAtLabel(document.generatedAt)}</p>
        </div>
        <div className="today-header__actions">
          <button
            className="today-secondary-button"
            type="button"
            disabled={refreshing}
            aria-busy={refreshing}
            onClick={() => loadAgenda('refresh')}
          >
            {refreshing ? '更新中' : '刷新'}
          </button>
          <a
            href="/today?view=review"
            onClick={(event) => {
              event.preventDefault();
              onNavigate('/today?view=review');
            }}
          >
            打开每日回顾
          </a>
        </div>
      </header>

      {refreshError ? (
        <p className="today-refresh-error" role="alert">刷新失败：{refreshError}</p>
      ) : null}

      <AgendaSection
        id="today-lessons"
        heading="今日课程"
        items={groups.lessons}
        emptyMessage="今天没有课程安排。"
        onNavigate={onNavigate}
      />
      <AgendaSection
        id="today-pending-actions"
        heading="待确认动作"
        items={groups.pendingActions}
        emptyMessage="当前没有待确认动作。"
        onNavigate={onNavigate}
      />
      <AgendaSection
        id="today-memos"
        heading="到期备忘"
        items={groups.memos}
        emptyMessage="当前没有到期备忘。"
        onNavigate={onNavigate}
        focusMemo={focusMemo}
        focusedMemoRef={focusedMemoRef}
      />
      {groups.otherReminders.length > 0 ? (
        <AgendaSection
          id="today-other-reminders"
          heading="其他提醒"
          items={groups.otherReminders}
          emptyMessage=""
          onNavigate={onNavigate}
        />
      ) : null}
    </section>
  );
}

interface AgendaSectionProps {
  id: string;
  heading: string;
  items: readonly AgendaItem[];
  emptyMessage: string;
  onNavigate: (path: string) => void;
  focusMemo?: string;
  focusedMemoRef?: RefObject<HTMLElement | null>;
}

function AgendaSection({
  id,
  heading,
  items,
  emptyMessage,
  onNavigate,
  focusMemo,
  focusedMemoRef,
}: AgendaSectionProps) {
  return (
    <article className="page-card today-section" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`}>{heading}</h3>
      {items.length === 0 ? <p className="muted">{emptyMessage}</p> : (
        <ol className="today-agenda-list">
          {items.map((item) => {
            const focused = Boolean(
              focusMemo
              && item.kind === 'memo'
              && item.sourceRef.objectId === focusMemo,
            );
            return (
              <li key={item.id}>
                <AgendaItemView
                  item={item}
                  onNavigate={onNavigate}
                  focused={focused}
                  elementRef={focused ? focusedMemoRef : undefined}
                />
              </li>
            );
          })}
        </ol>
      )}
    </article>
  );
}

function safeBusinessDateLabel(businessDate: string): string {
  try {
    return formatBusinessDate(businessDate);
  } catch {
    return '业务日期不可用';
  }
}

function generatedAtLabel(generatedAt: string): string {
  const time = formatAgendaTime(generatedAt);
  return time ? `数据生成于 ${time}` : '数据生成时间不可用';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
