interface AgentErrorCardProps {
  message: string;
  retryable?: boolean;
  retryAction?: 'resend-message' | 'retry-model' | 'retry-tool' | 'none';
  completedToolCount?: number;
  busy?: boolean;
  onRetry?: () => void;
}

export function AgentErrorCard({
  message,
  retryable = false,
  retryAction = 'none',
  completedToolCount = 0,
  busy = false,
  onRetry,
}: AgentErrorCardProps) {
  return (
    <section className="agent-error-card" role="alert">
      <strong>本次处理未完成</strong>
      <p>{message}</p>
      {completedToolCount > 0 && <span>已完成 {completedToolCount} 个工具调用，系统不会自动重复执行。</span>}
      {retryable && retryAction !== 'none' && onRetry ? (
        <button type="button" disabled={busy} onClick={onRetry}>
          {busy ? '正在重试…' : '安全重试'}
        </button>
      ) : (
        <span>可修改后重新发送，系统不会自动重复执行。</span>
      )}
    </section>
  );
}
