import type { TeachingRuntimeAvailability } from '../api/teaching-tasks';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

/** Teacher-facing, read-only projection of the existing runtime capability response. */
export function PlatformAIStatus({ availability, checkState, onRefresh }: {
  availability: TeachingRuntimeAvailability;
  checkState: 'checking' | 'ready' | 'error';
  onRefresh: () => void;
}) {
  const label = checkState === 'checking' ? '正在查询服务状态'
    : checkState === 'error' ? '无法获取服务状态'
      : availability === 'available' ? '教学 AI 已启用' : availability === 'test_only' ? '真实模型未启用' : '服务暂不可用';
  return <Card className="white-card settings-form"><CardContent>
    <div className="settings-card-heading"><h2>DeepSeek 服务</h2><Badge variant="secondary">DSH</Badge></div>
    <p>由平台统一提供 DeepSeek，教师无需购买或填写 API Key。</p>
    <p role="status">{label}</p>
    <p>{checkState === 'checking' ? '正在向平台查询，查询完成后显示结果。' : checkState === 'error' ? '平台状态查询失败，暂不能判断 DeepSeek 是否可用。学生档案、课表和人工记录仍可使用。' : availability === 'available' ? '平台已开放教学任务；实际模型请求是否成功，以对话中的任务回执为准。' : availability === 'test_only' ? '当前仅开放验证通道，尚不能执行真实模型任务。学生档案与人工记录仍可使用。' : '平台当前未提供教学 AI 能力。学生档案、课表和人工记录仍可使用。'}</p>
    <button type="button" className="button secondary" onClick={onRefresh} disabled={checkState === 'checking'}>重新检查</button>
  </CardContent></Card>;
}
