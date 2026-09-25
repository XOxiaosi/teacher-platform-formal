import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';

/** Read-only preview. Teachers never supply platform credentials. */
export function DeepSeekSettings() {
  return <Card className="white-card settings-form deepseek-settings"><CardContent>
    <div className="settings-card-heading"><h2>DeepSeek 服务</h2><Badge variant="secondary">DSH</Badge></div>
    <p>由平台统一提供 AI 服务，教师无需填写 API Key 或选择模型。</p>
    <p role="status">演示页面，未连接真实 AI 服务。</p>
    <p className="settings-helper">正式服务状态以登录后的工作台为准。</p>
  </CardContent></Card>;
}
