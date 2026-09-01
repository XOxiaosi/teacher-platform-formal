import type { AgentTurnDto } from '../../api/conversations';
import { AgentErrorCard } from './AgentErrorCard';
import { ConfirmationTurnCard } from './ConfirmationTurnCard';
import { ObjectReferenceLinks } from './ObjectReferenceLinks';
import { PresentationDocumentView } from './PresentationDocumentView';
import { ToolTurnCard } from './ToolTurnCard';

function TextTurn({
  turn,
  onNavigate,
}: {
  turn: Extract<AgentTurnDto, { kind: 'user' | 'assistant' }>;
  onNavigate?: (path: string) => void;
}) {
  if (turn.kind === 'assistant' && turn.presentation) {
    return <PresentationDocumentView document={turn.presentation} onNavigate={onNavigate} />;
  }
  return (
    <article className={`turn turn--${turn.kind}`}>
      <span className="turn-kind">{turn.kind === 'user' ? '你' : 'Agent'}</span>
      <p>{turn.content}</p>
      {turn.kind === 'assistant' && (
        <ObjectReferenceLinks references={turn.references} onNavigate={onNavigate} />
      )}
    </article>
  );
}

interface TurnListProps {
  turns: AgentTurnDto[];
  onNavigate?: (path: string) => void;
  onConfirmAction?: (actionId: string, actionToken: string) => void;
  onCancelAction?: (actionId: string) => void;
  onRetryExecution?: (executionId: string) => void;
  executionBusy?: boolean;
  confirmationBusyActionId?: string | null;
  confirmationOperation?: 'confirm' | 'cancel' | null;
  confirmationErrors?: Record<string, string>;
  readonly?: boolean;
}

export function TurnList({
  turns,
  onNavigate,
  onConfirmAction,
  onCancelAction,
  onRetryExecution,
  executionBusy = false,
  confirmationBusyActionId = null,
  confirmationOperation = null,
  confirmationErrors = {},
  readonly = false,
}: TurnListProps) {
  return (
    <div className="turn-list">
      <a className="skip-to-latest" href="#latest-turn">跳到最新消息</a>
      <div aria-live="polite">
        {turns.map((turn) => {
          if (turn.kind === 'user' || turn.kind === 'assistant') {
            return <TextTurn key={turn.id} turn={turn} onNavigate={onNavigate} />;
          }
          if (turn.kind === 'tool') {
            return <ToolTurnCard key={turn.id} turn={turn} onNavigate={onNavigate} />;
          }
          if (turn.kind === 'error') {
            return (
              <AgentErrorCard
                key={turn.id}
                message={turn.error.message}
                retryable={turn.retryable}
                retryAction={turn.retryAction}
                completedToolCount={turn.completedToolCallIds.length}
                busy={executionBusy}
                onRetry={onRetryExecution ? () => onRetryExecution(turn.executionId) : undefined}
              />
            );
          }
          return (
            <ConfirmationTurnCard
              key={turn.id}
              turn={turn}
              busy={confirmationBusyActionId === turn.actionId}
              operation={confirmationBusyActionId === turn.actionId ? confirmationOperation : null}
              error={confirmationErrors[turn.actionId]}
              readonly={readonly}
              onConfirmAction={onConfirmAction}
              onCancelAction={onCancelAction}
            />
          );
        })}
      </div>
      <span id="latest-turn" tabIndex={-1} aria-label="最新消息位置" />
    </div>
  );
}
