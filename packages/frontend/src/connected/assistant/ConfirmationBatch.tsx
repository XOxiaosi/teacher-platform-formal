import type { ConfirmationStatus, ConfirmationTurnDto } from '../../api/conversations';
import type { CommonError } from '../../api/types';
import * as React from 'react';

export interface ConfirmationBatchItemState {
  status?: ConfirmationStatus;
  busy?: boolean;
  error?: string | CommonError | null;
}

export interface ConfirmationBatchProps {
  turns: ConfirmationTurnDto[];
  itemStates?: Record<string, ConfirmationBatchItemState | undefined>;
  onConfirm: (selectedActionIds: string[], selectedTurns: ConfirmationTurnDto[]) => void;
  title?: string;
}

const EMPTY_ITEM_STATES: Record<string, ConfirmationBatchItemState | undefined> = {};

const actionLabels: Record<string, string> = {
  'scheduling.create': '安排课程',
  'memos.create': '添加待办',
  'students.create': '登记学生',
};

function actionLabel(actionName: string): string {
  return actionLabels[actionName] ?? '更新教学资料';
}

function errorMessage(error: string | CommonError | null | undefined): string | null {
  return typeof error === 'string' ? error : error?.message ?? null;
}

function statusLabel(status: ConfirmationStatus, error: string | null): string {
  if (error) return '需重试';
  if (status === 'consumed') return '已保存';
  if (status === 'running') return '处理中';
  if (status === 'cancelled') return '已取消';
  if (status === 'expired') return '已过期';
  return '待确认';
}

function isEligible(turn: ConfirmationTurnDto, status: ConfirmationStatus): boolean {
  const expiresAt = Date.parse(turn.expiresAt);
  return status === 'pending' && Boolean(turn.actionToken) && Number.isFinite(expiresAt) && expiresAt > Date.now();
}

export function ConfirmationBatch({ turns, itemStates = EMPTY_ITEM_STATES, onConfirm, title = '确认这些教学安排' }: ConfirmationBatchProps) {
  const initialized = React.useRef(false);
  const knownActionIds = React.useRef<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(() => new Set(
    turns.filter(turn => {
      const state = itemStates[turn.actionId];
      return isEligible(turn, state?.status ?? turn.status);
    }).map(turn => turn.actionId),
  ));

  React.useEffect(() => {
    setSelectedIds(previous => {
      const eligibleIds = new Set(turns.filter(turn => isEligible(turn, itemStates[turn.actionId]?.status ?? turn.status)).map(turn => turn.actionId));
      const next = initialized.current
        ? new Set([...previous].filter(id => eligibleIds.has(id)))
        : new Set(eligibleIds);
      if (initialized.current) {
        eligibleIds.forEach(id => { if (!knownActionIds.current.has(id)) next.add(id); });
      }
      initialized.current = true;
      knownActionIds.current = new Set(turns.map(turn => turn.actionId));
      if (next.size === previous.size && [...next].every(id => previous.has(id))) return previous;
      return next;
    });
  }, [itemStates, turns]);

  if (turns.length === 0) return null;

  const toggle = (actionId: string, checked: boolean) => {
    setSelectedIds(previous => {
      const next = new Set(previous);
      if (checked) next.add(actionId); else next.delete(actionId);
      return next;
    });
  };

  const selectedTurns = turns.filter(turn => selectedIds.has(turn.actionId) && isEligible(turn, itemStates[turn.actionId]?.status ?? turn.status));
  const selectedItemBusy = selectedTurns.some(turn => Boolean(itemStates[turn.actionId]?.busy) || (itemStates[turn.actionId]?.status ?? turn.status) === 'running');
  return <section className="assistant-confirmation-batch" aria-label={title}>
    <header className="assistant-confirmation-batch-heading">
      <div><h3>{title}</h3><p>逐项核对后，一次确认选中的项目。</p></div>
      <span>{selectedTurns.length}/{turns.length} 项</span>
    </header>
    <div className="assistant-confirmation-batch-list">
      {turns.map(turn => {
        const state = itemStates[turn.actionId];
        const status = state?.status ?? turn.status;
        const error = errorMessage(state?.error ?? turn.error);
        const busy = Boolean(state?.busy) || status === 'running';
        const eligible = isEligible(turn, status);
        const selectable = eligible && !busy;
        const unavailableLabel = status === 'pending' && !eligible ? '已过期' : statusLabel(status, error);
        const id = `confirmation-batch-${turn.actionId}`;
        return <label className={`assistant-confirmation-batch-item${selectable ? '' : ' is-complete'}`} key={turn.actionId} htmlFor={id}>
          <input id={id} type="checkbox" checked={selectedIds.has(turn.actionId)} disabled={!selectable} onChange={event => toggle(turn.actionId, event.target.checked)} />
          <span className="assistant-confirmation-batch-copy"><strong>{actionLabel(turn.actionName)}</strong><span>{turn.afterSummary}</span>{error && <small role="alert">{error}</small>}</span>
          <span className={`assistant-confirmation-batch-status status-${unavailableLabel.replace(/[^\u4e00-\u9fff\w]+/g, '-')}`}>{busy ? '处理中' : unavailableLabel}</span>
        </label>;
      })}
    </div>
    <button type="button" className="assistant-confirmation-batch-submit" disabled={selectedTurns.length === 0 || selectedItemBusy} onClick={() => onConfirm(selectedTurns.map(turn => turn.actionId), selectedTurns)}>
      确认选中的 {selectedTurns.length} 项
    </button>
  </section>;
}
