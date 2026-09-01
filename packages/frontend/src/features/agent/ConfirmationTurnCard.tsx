import type { ConfirmationTurnDto } from '../../api/conversations';

const ACTION_LABELS: Record<string, string> = {
  'scheduling.complete': '完成日程',
  'scheduling.cancel': '取消日程',
  'lessons.updateStatus': '更新课次状态',
  'students.updateStatus': '更新学生状态',
};

const STATUS_LABELS: Record<ConfirmationTurnDto['status'], string> = {
  pending: '等待确认',
  running: '执行中',
  consumed: '已完成',
  cancelled: '已取消',
  expired: '已过期',
};

interface ConfirmationTurnCardProps {
  turn: ConfirmationTurnDto;
  busy?: boolean;
  operation?: 'confirm' | 'cancel' | null;
  error?: string;
  readonly?: boolean;
  onConfirmAction?: (actionId: string, actionToken: string) => void;
  onCancelAction?: (actionId: string) => void;
}

function displayTime(value: string): string {
  return value.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

export function ConfirmationTurnCard({
  turn,
  busy = false,
  operation = null,
  error,
  readonly = false,
  onConfirmAction,
  onCancelAction,
}: ConfirmationTurnCardProps) {
  const actionLabel = ACTION_LABELS[turn.actionName] ?? turn.actionName;
  const pending = turn.status === 'pending';
  const confirmDisabled = busy || readonly || !turn.actionToken || !onConfirmAction;
  const cancelDisabled = busy || readonly || !onCancelAction;

  return (
    <article
      className={`turn confirmation-card confirmation-card--${turn.status}`}
      aria-label={`待确认操作：${actionLabel}`}
    >
      <header className="confirmation-card__header">
        <div>
          <span className="turn-kind">待确认操作</span>
          <h3>{actionLabel}</h3>
          <code>{turn.actionName}</code>
        </div>
        <span className={`confirmation-status confirmation-status--${turn.status}`}>
          {STATUS_LABELS[turn.status]}
        </span>
      </header>

      <div className="confirmation-target">
        <span>操作对象</span>
        <strong>{turn.target.type} · {turn.target.id}</strong>
      </div>

      <div className="confirmation-change">
        {turn.beforeSummary && <p><span>当前</span>{turn.beforeSummary}</p>}
        <p><span>执行后</span>{turn.afterSummary}</p>
      </div>

      {Object.keys(turn.parameterSummary).length > 0 && (
        <dl className="confirmation-parameters">
          {Object.entries(turn.parameterSummary).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value === null ? '空' : String(value)}</dd>
            </div>
          ))}
        </dl>
      )}

      <p className="confirmation-expiry">服务端有效期至 {displayTime(turn.expiresAt)}</p>
      {(error || turn.error) && (
        <p className="confirmation-error" role="alert">{error ?? turn.error?.message}</p>
      )}

      {pending && (
        <div className="confirmation-actions">
          <button
            type="button"
            className="confirmation-confirm"
            disabled={confirmDisabled}
            aria-label={busy && operation === 'confirm' ? '正在确认…' : '确认执行'}
            onClick={() => {
              if (turn.actionToken) onConfirmAction?.(turn.actionId, turn.actionToken);
            }}
          >{busy && operation === 'confirm' ? '正在确认…' : '确认执行'}</button>
          <button
            type="button"
            className="confirmation-cancel"
            disabled={cancelDisabled}
            aria-label={busy && operation === 'cancel' ? '正在取消…' : '取消操作'}
            onClick={() => onCancelAction?.(turn.actionId)}
          >{busy && operation === 'cancel' ? '正在取消…' : '取消操作'}</button>
        </div>
      )}
    </article>
  );
}
