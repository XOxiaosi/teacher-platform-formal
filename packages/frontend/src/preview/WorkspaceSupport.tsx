import { useState, type FormEvent } from 'react';
import { BookOpen, CircleHelp, SlidersHorizontal } from 'lucide-react';
import type { PreviewActions } from './PreviewApp';
import { usePreviewState } from './ui-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import './workspace-support.css';

type Preferences = { background: string; expression: string };
type SupportDraft = { subject: string; detail: string };
const emptyPreferences: Preferences = { background: '', expression: '' };
const emptyFeedback: SupportDraft = { subject: '', detail: '' };

export function WorkspaceSupport({ actions }: { actions: PreviewActions }) {
  return <><TeachingPreferences actions={actions} /><WorkspaceHelp actions={actions} /></>;
}

function TeachingPreferences({ actions }: { actions: PreviewActions }) {
  const [saved, setSaved] = usePreviewState(actions, 'support.preferences.saved', emptyPreferences);
  const [draft, setDraft] = usePreviewState(actions, 'support.preferences.draft', saved);
  const [notice, setNotice] = useState('');
  const dirty = draft.background !== saved.background || draft.expression !== saved.expression;
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (actions.connected) return;
    const next = { background: draft.background.trim(), expression: draft.expression.trim() };
    setDraft(next); setSaved(next); setNotice('演示偏好已保留，刷新后重置；尚未写入助手记忆。');
  };
  return <Card className="white-card settings-form workspace-support"><CardContent>
    <div className="support-heading"><SlidersHorizontal size={20} aria-hidden="true" /><div><h2>教学偏好</h2><p>让助手逐渐熟悉你的教学方式。</p></div></div>
    {actions.connected ? <p role="status">教学偏好管理接口尚未接入。你可以在当前对话中说明本次要求。</p> : <form onSubmit={save}>
      <label htmlFor="teacher-background">教学背景<Input id="teacher-background" value={draft.background} placeholder="例如：初中数学，主要是一对一辅导" onChange={event => { setDraft({ ...draft, background: event.target.value }); setNotice(''); }} /></label>
      <label htmlFor="teacher-expression">常用表达与输出偏好<Textarea id="teacher-expression" value={draft.expression} placeholder="例如：给家长的反馈简洁温和，先讲具体进步" onChange={event => { setDraft({ ...draft, expression: event.target.value }); setNotice(''); }} /></label>
      <p className="support-hint">设计预览：只演示偏好管理，不影响学生事实、课时余额或确认规则。</p>
      <div className="button-row"><Button disabled={!dirty}>保存演示偏好</Button><Button type="button" variant="outline" disabled={!dirty} onClick={() => { setDraft(saved); setNotice(''); }}>取消修改</Button><Button type="button" variant="ghost" disabled={!saved.background && !saved.expression} onClick={() => { setSaved(emptyPreferences); setDraft(emptyPreferences); setNotice('演示偏好已清除。'); }}>清除演示偏好</Button></div>
      {notice && <p role="status" className="support-hint">{notice}</p>}
    </form>}
    <div className="support-memory"><BookOpen size={17} aria-hidden="true" /><span>学生情况以已核对记录为依据；需要更正时，从学生档案查看来源并修改。</span><a href="#/students">查看学生档案 →</a></div>
  </CardContent></Card>;
}

function WorkspaceHelp({ actions }: { actions: PreviewActions }) {
  const [draft, setDraft] = usePreviewState(actions, 'support.feedback.draft', emptyFeedback);
  const [issue, setIssue] = usePreviewState<SupportDraft | null>(actions, 'support.feedback.issue', null);
  const [error, setError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (actions.connected) return;
    if (!draft.subject.trim() || !draft.detail.trim()) { setError('请填写问题标题和具体情况。'); return; }
    setIssue({ subject: draft.subject.trim(), detail: draft.detail.trim() }); setDraft(emptyFeedback); setError('');
  };
  return <Card className="white-card settings-form workspace-support"><CardContent>
    <div className="support-heading"><CircleHelp size={20} aria-hidden="true" /><div><h2>帮助与问题反馈</h2><p>遇到问题时，先保留已经完成的工作。</p></div></div>
    <div className="support-faq">
      <details><summary>如何连接微信并查看学生反馈？</summary><p>从微信连接页打开二维码，使用手机微信扫码并确认。同一部手机不方便扫描时，请在电脑或另一块屏幕打开页面。连接后，你通过机器人录入的学生情况会进入今日工作台，核对后才成为正式记录。</p><a href="#/settings/wechat">打开微信连接 →</a></details>
      <details><summary>提示已保存，但页面没有新记录怎么办？</summary><p>先核对当前账号和学生，再重新加载资料。已经收到保存回执的操作不要重复提交；仍找不到时，反馈发生时间及具体步骤。</p></details>
      <details><summary>AI 暂不可用或额度不足，还能工作吗？</summary><p>可以继续查看学生档案、课表和人工记录。AI 服务只使用 DeepSeek；真实额度与恢复时间以后续服务状态为准，当前预览不显示虚构额度。</p></details>
      <details><summary>如何管理个人资料和隐私？</summary><p>数据与隐私页提供当前可用的数据操作。问题反馈由你选择必要描述，不自动附上全部聊天或学生资料。</p><a href="#/settings/privacy">查看数据与隐私 →</a></details>
    </div>
    <details className="support-feedback"><summary>记录一个使用问题</summary>
      {actions.connected ? <p role="status">问题反馈服务尚未接入，暂不能提交。请保留问题描述和发生时间。</p> : <form onSubmit={submit}>
        <label htmlFor="support-subject">问题标题<Input id="support-subject" value={draft.subject} onChange={event => setDraft({ ...draft, subject: event.target.value })} /></label>
        <label htmlFor="support-detail">具体情况<Textarea id="support-detail" value={draft.detail} placeholder="描述你刚才进行了什么操作，以及看到了什么" onChange={event => setDraft({ ...draft, detail: event.target.value })} /></label>
        <p className="support-hint">仅在本次预览保留标题和描述，不会发送给客服，也不会附带聊天或学生资料。</p>
        {error && <p role="alert">{error}</p>}<Button>保留演示问题</Button>
      </form>}
    </details>
    {!actions.connected && issue && <div className="support-issue" role="status"><b>{issue.subject}</b><span>演示问题 · 未提交</span><p>{issue.detail}</p><Button variant="ghost" size="sm" onClick={() => { setDraft(issue); setIssue(null); }}>继续编辑</Button></div>}
  </CardContent></Card>;
}
