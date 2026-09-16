import { FormEvent, useEffect, useState, type ReactNode } from 'react';
import { PreviewActions } from './PreviewApp';
import { usePreviewState } from './ui-state';
import './settings-configuration.css';
import { commitAction } from './action-result';
import { exportDownloadZip, exportPrivacy, exportStatus } from '../api/privacy';

type SettingsRoute = 'studio' | 'models' | 'wechat' | 'privacy';
type ModelChoice = 'default' | 'fast' | 'deep';
type WechatChannel = 'personal' | 'official';

const modelOptions: Array<{ value: ModelChoice; title: string; description: string }> = [
  { value: 'default', title: '平台默认', description: '适合大多数日常教学任务。' },
  { value: 'fast', title: '优先响应', description: '适合快速整理想法和推进日常工作。' },
  { value: 'deep', title: '深入分析', description: '适合需要更多推敲的复杂教学任务。' },
];

const channelOptions: Array<{ value: WechatChannel; title: string; description: string }> = [
  { value: 'personal', title: '教师个人微信入口', description: '个人工作入口' },
  { value: 'official', title: '公众号入口', description: '公众号工作入口' },
];

function settingsRoute(): SettingsRoute {
  const route = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
  return route[0] === 'settings' && ['models', 'wechat', 'privacy'].includes(route[1]) ? route[1] as SettingsRoute : 'studio';
}

export function SettingsPage({ actions, modelSettings }: { actions: PreviewActions; modelSettings?: ReactNode }) {
  const [route, setRoute] = useState<SettingsRoute>(settingsRoute);
  useEffect(() => { const onHashChange = () => setRoute(settingsRoute()); addEventListener('hashchange', onHashChange); return () => removeEventListener('hashchange', onHashChange); }, []);
  const subtitles: Record<SettingsRoute, string> = { studio: '管理工作室名称。', models: modelSettings ? '管理已接入的 API，选择需要使用的模型。' : '选择助手的响应偏好。', wechat: '', privacy: '了解数据使用与服务边界。' };
  return <section className="page preview-page settings-configuration"><header className="page-header"><div><h1>{route === 'studio' ? '设置' : route === 'models' ? modelSettings ? '模型与 API' : '模型选择' : route === 'wechat' ? '微信连接' : '数据与隐私'}</h1><p>{subtitles[route]}</p></div><a className="button secondary" href="#/today">返回工作台</a></header><div className="settings-layout"><SettingsNav route={route} connectedModels={Boolean(modelSettings)} /><div>{route === 'studio' && <div className="settings-stack"><StudioSettings actions={actions} />{modelSettings && <section className="white-card settings-form"><h2>模型与 API</h2><p>查看已有 API 配置，选择默认模型或修改模型 ID。</p><a className="button secondary" href="#/settings/models">管理模型与 API</a></section>}</div>}{route === 'models' && (modelSettings || <ModelSettings actions={actions} />)}{route === 'wechat' && <WechatSettings actions={actions} />}{route === 'privacy' && <PrivacySettings />}</div></div></section>;
}

function SettingsNav({ route, connectedModels }: { route: SettingsRoute; connectedModels: boolean }) {
  const links: Array<[SettingsRoute, string]> = [['studio', '工作室'], ['models', connectedModels ? '模型与 API' : '模型选择'], ['wechat', '微信连接'], ['privacy', '数据与隐私']];
  return <nav className="settings-nav" aria-label="设置分类">{links.map(([key, label]) => <a key={key} className={route === key ? 'active' : ''} aria-current={route === key ? 'page' : undefined} href={`#/settings/${key}`}>{label}</a>)}</nav>;
}

function StudioSettings({ actions }: { actions: PreviewActions }) {
  const [name, setName] = usePreviewState(actions, 'settings.studio.draft', actions.data.studioName); const [saved, setSaved] = useState(false);
  const dirty = name !== actions.data.studioName;
  const save = (event: FormEvent) => { event.preventDefault(); const next = name.trim(); if (!next || next === actions.data.studioName) { setName(actions.data.studioName); setSaved(false); return; } if (actions.savePreferences) return commitAction(actions, () => actions.savePreferences!({ studioName: next }), () => { setName(next); setSaved(true); actions.toast('工作室名称已更新'); }); actions.setData((old) => ({ ...old, studioName: next })); setName(next); setSaved(true); actions.toast('工作室名称已更新'); };
  return <form className="white-card settings-form" onSubmit={save}><h2>工作室名称</h2><label htmlFor="studio-name">显示名称<input id="studio-name" value={name} onChange={(event) => { setName(event.target.value); setSaved(false); }} required /></label><div className="button-row"><button type="button" className="button secondary" onClick={() => { setName(actions.data.studioName); setSaved(false); }} disabled={!dirty}>取消</button><button className="button primary" disabled={!dirty}>保存设置</button></div>{dirty && <p className="dirty-state" role="status">有未保存的更改。</p>}{saved && <p className="saved" role="status">设置已保存。</p>}</form>;
}

function ModelSettings({ actions }: { actions: PreviewActions }) {
  const savedChoice = (actions.data.settings?.modelChoice || 'default') as ModelChoice;
  const [choice, setChoice] = usePreviewState(actions, 'settings.models.draft', savedChoice); const [savedNotice, setSavedNotice] = useState(false); const [check, setCheck] = useState(false);
  const dirty = choice !== savedChoice;
  const save = () => { if (actions.savePreferences) return commitAction(actions, () => actions.savePreferences!({ modelChoice: choice }), () => { setSavedNotice(true); actions.toast('已保存'); }); actions.setData((old) => ({ ...old, settings: { ...old.settings, modelChoice: choice } })); setSavedNotice(true); actions.toast('已保存'); };
  const cancel = () => { setChoice(savedChoice); setSavedNotice(false); };
  return <div className="settings-stack"><section className="white-card settings-form"><h2>助手响应偏好</h2><div className="choice-list">{modelOptions.map((option) => <label className="choice-card" key={option.value}><input type="radio" name="model-choice" value={option.value} checked={choice === option.value} onChange={() => { setChoice(option.value); setSavedNotice(false); }} /><span><b>{option.title}</b><small>{option.description}</small></span></label>)}</div><div className="button-row"><button type="button" className="button secondary" onClick={cancel} disabled={!dirty}>取消</button><button type="button" className="button primary" onClick={save} disabled={!dirty}>保存设置</button></div>{dirty && <p className="dirty-state" role="status">有未保存的更改。</p>}{savedNotice && <p className="saved" role="status">设置已保存。</p>}</section><UnavailableCheck checked={check} onCheck={() => setCheck(true)} subject="模型未配置" status="当前尚未配置模型服务。" /></div>;
}

function WechatSettings({ actions }: { actions: PreviewActions }) {
  const savedChannel = (actions.data.settings?.wechatChannel || 'personal') as WechatChannel;
  const [channel, setChannel] = usePreviewState(actions, 'settings.wechat.draft', savedChannel); const [savedNotice, setSavedNotice] = useState(false); const [check, setCheck] = useState(false);
  const dirty = channel !== savedChannel;
  const save = () => { if (actions.savePreferences) return commitAction(actions, () => actions.savePreferences!({ wechatChannel: channel }), () => { setSavedNotice(true); actions.toast('已保存'); }); actions.setData((old) => ({ ...old, settings: { ...old.settings, wechatChannel: channel } })); setSavedNotice(true); actions.toast('已保存'); };
  return <div className="settings-stack"><section className="white-card settings-form"><h2>微信入口</h2><div className="choice-list">{channelOptions.map((option) => <label className="choice-card" key={option.value}><input type="radio" name="wechat-channel" value={option.value} checked={channel === option.value} onChange={() => { setChannel(option.value); setSavedNotice(false); }} /><span><b>{option.value === 'personal' ? '个人微信' : '公众号'}</b><small>{option.description}</small></span></label>)}</div><div className="button-row"><button type="button" className="button secondary" onClick={() => { setChannel(savedChannel); setSavedNotice(false); }} disabled={!dirty}>取消</button><button type="button" className="button primary" onClick={save} disabled={!dirty}>保存设置</button></div>{dirty && <p className="dirty-state" role="status">有未保存的更改。</p>}{savedNotice && <p className="saved" role="status">设置已保存。</p>}</section><UnavailableCheck checked={check} onCheck={() => setCheck(true)} subject="微信未连接" status="当前尚未连接微信。" /></div>;
}

function UnavailableCheck({ checked, onCheck, subject, status }: { checked: boolean; onCheck: () => void; subject: string; status: string }) {
  return <section className="white-card unavailable-card"><h2>{subject}</h2><p className="check-result" role="status">{status}</p><button type="button" className="button secondary" onClick={onCheck}>{checked ? '重新检查' : '检查状态'}</button></section>;
}

function PrivacySettings() {
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'failed'>('idle');
  const [message, setMessage] = useState('');
  const download = async () => {
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
  return <section className="white-card settings-form"><h2>数据操作</h2><p>可下载当前账号的教师记录和媒体原件。下载包只提供给当前登录账号，完成后服务端清理一次性产物。</p><div className="privacy-note"><b>可读导出</b><span>字段和媒体均经过严格完整性校验后解密，认证资料和凭据不会包含在包内。</span></div><div className="button-row"><button type="button" className="button primary" onClick={download} disabled={state === 'running'}>{state === 'running' ? '准备中…' : '下载可读数据包'}</button></div>{message && <p className={state === 'failed' ? 'error' : 'saved'} role="status">{message}</p>}</section>;
}
