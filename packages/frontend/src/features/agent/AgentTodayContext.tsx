import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { AgendaTodayDocument } from '@teacher-platform/contracts';
import { agendaApi } from '../../api/agenda';
import { formatBusinessDate } from '../../shared/agenda/agenda-time';
import { groupTodayAgenda } from '../../shared/agenda/agenda-view-model';

export interface AgentTodayApi {
  getToday(teacherId: string): Promise<AgendaTodayDocument>;
}

interface AgentTodayContextProps {
  teacherId: string;
  onNavigate?: (path: string) => void;
  api?: AgentTodayApi;
}

export function AgentTodayContext({
  teacherId,
  onNavigate,
  api = agendaApi,
}: AgentTodayContextProps) {
  const [document, setDocument] = useState<AgendaTodayDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const pendingGeneration = useRef<number | null>(null);

  const load = useCallback(() => {
    if (pendingGeneration.current !== null) return;
    const requestGeneration = ++generation.current;
    pendingGeneration.current = requestGeneration;
    setDocument(null);
    setError(null);
    setLoading(true);

    void api.getToday(teacherId)
      .then((nextDocument) => {
        if (generation.current !== requestGeneration) return;
        setDocument(nextDocument);
      })
      .catch((loadError: unknown) => {
        if (generation.current !== requestGeneration) return;
        setError(messageOf(loadError));
      })
      .finally(() => {
        if (generation.current !== requestGeneration) return;
        pendingGeneration.current = null;
        setLoading(false);
      });
  }, [api, teacherId]);

  useEffect(() => {
    load();
    return () => {
      generation.current += 1;
      pendingGeneration.current = null;
    };
  }, [load]);

  const groups = useMemo(
    () => document ? groupTodayAgenda(document.items) : null,
    [document],
  );

  return (
    <section className="agent-today-context" aria-labelledby="agent-today-heading">
      <div className="agent-today-context__heading">
        <div>
          <p className="eyebrow">Agenda</p>
          <h3 id="agent-today-heading">今日</h3>
        </div>
        {document ? <span>{safeDateLabel(document.businessDate)}</span> : null}
      </div>

      {loading ? <p className="agent-context-state" aria-live="polite">正在加载今日摘要</p> : null}
      {!loading && error ? (
        <div className="agent-context-error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={load}>重试今日摘要</button>
        </div>
      ) : null}
      {!loading && document && groups ? (
        <>
          <ul className="agent-today-counts" aria-label="今日事项数量">
            <li>{groups.lessons.length}节课程</li>
            <li>{groups.pendingActions.length}项待确认</li>
            <li>{groups.memos.length}条到期备忘</li>
          </ul>
          {document.items.length === 0 ? (
            <p className="agent-context-state">今天没有待办事项</p>
          ) : (
            <ol className="agent-today-items">
              {document.items.slice(0, 3).map((item) => (
                <li key={item.id}>{item.title}</li>
              ))}
            </ol>
          )}
          <a
            className="agent-today-link"
            href="/today"
            onClick={(event) => {
              if (!onNavigate) return;
              event.preventDefault();
              onNavigate('/today');
            }}
          >
            打开今日
          </a>
        </>
      ) : null}
    </section>
  );
}

function safeDateLabel(date: string): string {
  try {
    return formatBusinessDate(date).split(' · ')[0] ?? date;
  } catch {
    return '日期不可用';
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
