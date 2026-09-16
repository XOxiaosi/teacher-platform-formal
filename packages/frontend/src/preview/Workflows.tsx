import { PreviewActions } from './PreviewApp';
import { FinancePage } from './Finance';
import { FeedbackPage, SettingsPage } from './FeedbackSettings';
import { SchedulesPage } from './SchedulePage';
import './workflows.css';
import type { ReactNode } from 'react';
import { AssistantWorkspace } from '../connected/assistant';
import type { AssistantTransport } from '../connected/assistant/transport';

export function Workflows({ page, actions, modelSettings, teacherId, assistantTransport }: {
  page: string; actions: PreviewActions; modelSettings?: ReactNode; teacherId?: string; assistantTransport?: AssistantTransport;
}) {
  if (page === 'agent') {
    if (actions.connected && teacherId) return <AssistantWorkspace teacherId={teacherId} transport={assistantTransport} />;
    return <AgentPage connected={Boolean(actions.connected)} />;
  }
  if (page === 'schedules') return <SchedulesPage actions={actions} />;
  if (page === 'finance') return <FinancePage actions={actions} />;
  if (page === 'feedback') return <FeedbackPage actions={actions} />;
  return <SettingsPage actions={actions} modelSettings={modelSettings} />;
}
export { scheduleGeometry, weekTimeRange } from './SchedulePage';

function AgentPage({ connected }: { connected: boolean }) {
  return <section className="page preview-page agent-workspace"><header><h1>AI 助手</h1></header>
    <div className="agent-empty"><span className="connection-status">{connected ? '模型调用未启用' : '模型未配置'}</span><h2>助手暂不可用</h2><p>{connected ? '你可以管理 API 和默认模型；对话功能尚未开放。学生档案与人工记录可继续使用。' : '模型服务尚未连接。你仍可以查看学生档案、记录学习情况。'}</p><div className="button-row"><a className="button primary" href="#/students">记录学生情况</a><a className="button secondary" href="#/settings/models">{connected ? '选择模型与 API' : '设置响应偏好'}</a></div></div>
    <div className="agent-composer"><label className="sr-only" htmlFor="assistant-message">发送消息</label><textarea id="assistant-message" disabled placeholder="模型服务暂不可用" /><button className="button secondary" disabled>发送</button></div>
  </section>;
}
