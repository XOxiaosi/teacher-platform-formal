import type { TeachingRuntimeAvailability } from '../api/teaching-tasks';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

/** Teacher-facing, read-only projection of the existing runtime capability response. */
export function PlatformAIStatus({ availability }: { availability: TeachingRuntimeAvailability }) {
  const label = availability === 'available' ? '教学 AI 已启用' : availability === 'test_only' ? '真实模型未启用' : '服务暂不可用';
  return <Card className="white-card settings-form"><CardContent>
    <div className="settings-card-heading"><h2>DeepSeek 服务</h2><Badge variant="secondary">DSH</Badge></div>
    <p>由平台统一提供 DeepSeek，教师无需购买或填写 API Key。</p>
    <p role="status">{label}</p>
    <p>{availability === 'available' ? '当前服务允许发起教学任务；具体任务结果以对话中的实际回执为准。' : availability === 'test_only' ? '当前仅开放验证通道，尚不能执行真实模型任务。学生档案与人工记录仍可使用。' : '当前无法使用教学 AI，或暂未取得服务状态。学生档案、课表和人工记录仍可使用。'}</p>
  </CardContent></Card>;
}
