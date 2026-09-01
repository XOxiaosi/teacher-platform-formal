import type { ToolTurnDto } from '../../api/conversations';
import { ObjectReferenceLinks } from './ObjectReferenceLinks';

const sideEffectLabels: Record<ToolTurnDto['sideEffect'], string> = {
  read: '只读',
  create: '创建',
  update: '更新',
  destructive: '高风险',
};

const statusLabels: Record<ToolTurnDto['status'], string> = {
  waiting: '等待中',
  running: '执行中',
  success: '成功',
  failed: '失败',
  partial: '部分完成',
  cancelled: '已取消',
};

function valueText(value: string | number | boolean | null): string {
  if (value === null) return '空';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

export function ToolTurnCard({
  turn,
  onNavigate,
}: {
  turn: ToolTurnDto;
  onNavigate?: (path: string) => void;
}) {
  const failed = turn.status === 'failed';
  return (
    <article
      className={failed ? 'tool-card tool-card--failed' : 'tool-card'}
      aria-label={`工具：${turn.displayName}`}
    >
      <header className="tool-card-header">
        <div>
          <span className="tool-card-kicker">工具调用</span>
          <h3>{turn.displayName}</h3>
        </div>
        <div className="tool-card-badges">
          <span>{sideEffectLabels[turn.sideEffect]}</span>
          <span className={`tool-status tool-status--${turn.status}`}>{statusLabels[turn.status]}</span>
        </div>
      </header>

      <p className="tool-result">{turn.error?.message ?? turn.resultSummary ?? '暂无结果摘要'}</p>
      <ObjectReferenceLinks references={turn.references} onNavigate={onNavigate} />

      <details>
        <summary>查看调用详情</summary>
        <dl className="tool-input-list">
          {Object.entries(turn.inputSummary).map(([key, value]) => (
            <div key={key}><dt>{key}</dt><dd>{valueText(value)}</dd></div>
          ))}
        </dl>
      </details>
    </article>
  );
}
