import './moderation-flag.css';

/**
 * 本地风险标记可见化（D51：Communication / ParentFeedback 的
 * moderationFlagged + moderationReasons 三态投影）。
 *
 * 三态语义（与后端冻结一致）：
 * - true + reasons[]    → 本地命中，展示 badge + 白名单原因；
 * - false / null        → 本地通过或未配置，不渲染任何内容。
 *
 * reasons 为后端写入的人工可读字符串（如 `violence（暴力/威胁言论）`），
 * 直接展示，不做二次翻译。
 */
interface ModerationFlagProps {
  flagged: boolean | null;
  reasons: string[] | null;
}

export function ModerationFlag({ flagged, reasons }: ModerationFlagProps) {
  if (flagged !== true) return null;

  const items = Array.isArray(reasons) && reasons.length > 0 ? reasons : null;

  return (
    <div className="moderation-flag">
      <span className="moderation-flag-badge">风险标记</span>
      {items ? (
        <ul className="moderation-flag-reasons">
          {items.map((reason, index) => (
            <li key={`${reason}-${index}`} className="moderation-flag-reason">
              {reason}
            </li>
          ))}
        </ul>
      ) : (
        <p className="moderation-flag-fallback">内容命中本地风险规则，请人工复核后再发送</p>
      )}
    </div>
  );
}
