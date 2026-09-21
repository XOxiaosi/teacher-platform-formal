import { FormEvent, useEffect, useState, type ReactNode } from 'react';
import { PreviewActions } from './PreviewApp';
import { usePreviewState } from './ui-state';
import { WorkspaceSupport } from './WorkspaceSupport';
import { DeepSeekSettings } from './DeepSeekSettings';
import { WechatConnectionSettings } from './WechatConnectionSettings';
import './settings-configuration.css';
import './redesign-business.css';
import { commitAction } from './action-result';
import { exportDownloadZip, exportPrivacy, exportStatus } from '../privacy-export-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

type SettingsRoute = 'studio' | 'models' | 'wechat' | 'privacy';

function settingsRoute(): SettingsRoute {
  const route = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
  return route[0] === 'settings' && ['models', 'wechat', 'privacy'].includes(route[1]) ? route[1] as SettingsRoute : 'studio';
}

export function SettingsPage({ actions, modelSettings }: { actions: PreviewActions; modelSettings?: ReactNode }) {
  const [route, setRoute] = useState<SettingsRoute>(settingsRoute);
  useEffect(() => { const onHashChange = () => setRoute(settingsRoute()); addEventListener('hashchange', onHashChange); return () => removeEventListener('hashchange', onHashChange); }, []);
  const subtitles: Record<SettingsRoute, string> = { studio: '管理工作室和常用支持。', models: actions.connected ? '查看平台 DeepSeek 服务状态。' : 'DSH + DeepSeek 的演示配置入口。', wechat: '连接状态与扫码步骤清楚可见。', privacy: '了解数据使用与服务边界。' };
  const title = route === 'studio' ? '设置' : route === 'models' ? modelSettings ? 'AI 服务' : '模型设置' : route === 'wechat' ? '微信连接' : '数据与隐私';
  return <section className="page preview-page settings-configuration"><header className="page-header"><div><h1>{title}</h1><p>{subtitles[route]}</p></div><Button asChild variant="outline"><a href="#/today">返回工作台</a></Button></header><div className="settings-layout"><SettingsNav route={route} connectedModels={Boolean(modelSettings)} /><div>{route === 'studio' && <div className="settings-stack"><StudioSettings actions={actions} /><ConnectionShortcuts connected={Boolean(actions.connected)} /><WorkspaceSupport actions={actions} /></div>}{route === 'models' && (modelSettings || (actions.connected ? <Card className="white-card settings-form"><CardContent><h2>DeepSeek 服务</h2><p role="status">暂无法获取服务状态，请稍后重试。教师无需填写自己的 API Key。</p></CardContent></Card> : <DeepSeekSettings />))}{route === 'wechat' && <WechatConnectionSettings actions={actions} />}{route === 'privacy' && <PrivacySettings actions={actions} />}</div></div></section>;
}

function SettingsNav({ route, connectedModels }: { route: SettingsRoute; connectedModels: boolean }) {
  const links: Array<[SettingsRoute, string]> = [['studio', '工作室'], ['models', connectedModels ? 'AI 服务' : '模型设置'], ['wechat', '微信连接'], ['privacy', '数据与隐私']];
  return <nav className="settings-nav" aria-label="设置分类">{links.map(([key, label]) => <a key={key} className={route === key ? 'active' : ''} aria-current={route === key ? 'page' : undefined} href={`#/settings/${key}`}>{label}</a>)}</nav>;
}

function StudioSettings({ actions }: { actions: PreviewActions }) {
  const [name, setName] = usePreviewState(actions, 'settings.studio.draft', actions.data.studioName); const [saved, setSaved] = useState(false);
  const dirty = name !== actions.data.studioName;
  const save = (event: FormEvent) => { event.preventDefault(); const next = name.trim(); if (!next || next === actions.data.studioName) { setName(actions.data.studioName); setSaved(false); return; } if (actions.savePreferences) return commitAction(actions, () => actions.savePreferences!({ studioName: next }), () => { setName(next); setSaved(true); actions.toast('工作室名称已更新'); }); actions.setData((old) => ({ ...old, studioName: next })); setName(next); setSaved(true); actions.toast('工作室名称已更新'); };
  return <Card className="white-card settings-form"><CardContent><form onSubmit={save}><h2>工作室名称</h2><label htmlFor="studio-name">显示名称<Input id="studio-name" value={name} onChange={(event) => { setName(event.target.value); setSaved(false); }} required /></label><div className="button-row"><Button type="button" variant="outline" onClick={() => { setName(actions.data.studioName); setSaved(false); }} disabled={!dirty}>取消</Button><Button disabled={!dirty}>保存设置</Button></div>{dirty && <p className="dirty-state" role="status">有未保存的更改。</p>}{saved && <p className="saved" role="status">设置已保存。</p>}</form></CardContent></Card>;
}

function ConnectionShortcuts({ connected }: { connected: boolean }) {
  return <Card className="white-card settings-form connection-shortcuts"><CardContent><h2>连接与服务</h2><p>{connected ? '查看 AI 服务与微信连接状态。' : '模型与微信连接分别管理，演示配置不会改变真实服务状态。'}</p><div className="button-row"><Button asChild variant="outline"><a href="#/settings/models">{connected ? 'DeepSeek 服务' : 'DeepSeek 演示配置'}</a></Button><Button asChild variant="outline"><a href="#/settings/wechat">连接微信</a></Button></div></CardContent></Card>;
}

function PrivacySettings({ actions }: { actions: PreviewActions }) {
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'failed'>('idle');
  const [message, setMessage] = useState('');
  const download = async () => {
    if (!actions.connected) { setState('done'); setMessage('演示环境未导出数据，也不会请求真实隐私接口。'); return; }
    setState('running'); setMessage('正在准备可读数据包…');
    try {
      const { jobId } = await exportPrivacy({ format: 'readable' });
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const status = await exportStatus(jobId);
        if (status.status === 'failed') throw new Error(status.error || '导出失败');
        if (status.status === 'succeeded') {
          const result = await exportDownloadZip(jobId);
          const url = URL.createObjectURL(result.blob);
          const anchor = document.createElement('a'); anchor.href = url; anchor.download = result.filename || 'teacher-data-readable.zip'; anchor.click();
          setTimeout(() => URL.revokeObjectURL(url), 0);
          setState('done'); setMessage('可读数据包已下载。'); return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error('导出等待超时，请稍后重试');
    } catch (error) { setState('failed'); setMessage(error instanceof Error ? error.message : '导出失败，请稍后重试'); }
  };
  return <Card className="white-card settings-form"><CardContent><h2>数据操作</h2><p>可下载当前账号的教师记录和媒体原件。下载包只提供给当前登录账号，完成后服务端清理一次性产物。</p>{!actions.connected && <p className="settings-helper">当前为预览演示：按钮不会导出数据，也不会访问真实隐私接口。</p>}<div className="privacy-note"><b>可读导出</b><span>字段和媒体均经过严格完整性校验后解密，认证资料和凭据不会包含在包内。</span></div><div className="button-row"><Button type="button" onClick={download} disabled={state === 'running'}>{state === 'running' ? '准备中…' : actions.connected ? '下载可读数据包' : '演示下载可读数据包'}</Button></div>{message && <p className={state === 'failed' ? 'error' : 'saved'} role="status">{message}</p>}</CardContent></Card>;
}
