import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createProviderConfig,
  listProviderConfigs,
  setPrimaryProviderConfig,
  updateProviderConfig,
} from '../api/providerConfigs';
import { apiRequest } from '../api/client';
import type { ProviderConfigDto, ProviderConfigKind } from '../api/types';
import { me } from '../api/auth';
import './model-configuration.css';

type Capabilities = {
  configurationEnabled: boolean;
  runtimeEnabled: boolean;
  connectionTestEnabled: boolean;
  endpointValidation: 'static' | 'dns-guarded';
};

type Draft = { displayName: string; baseUrl: string; model: string; apiKey: string };
type NewDraft = Draft & { providerKind: ProviderConfigKind; providerName: string };

const emptyNewDraft = (): NewDraft => ({ providerKind: 'openai', providerName: '', displayName: '', baseUrl: '', model: '', apiKey: '' });

function toDraft(config: ProviderConfigDto): Draft {
  return { displayName: config.displayName ?? '', baseUrl: config.baseUrl, model: config.model, apiKey: '' };
}

function validateDraft(draft: Draft, creating = false): string {
  if (!draft.model.trim()) return '请填写模型 ID。';
  if (!draft.baseUrl.trim()) return '请填写 API 地址。';
  try { new URL(draft.baseUrl.trim()); } catch { return 'API 地址格式不正确。'; }
  if (creating && !draft.apiKey.trim()) return '新增配置需要填写 API Key。';
  return '';
}

export function ModelConfiguration({ teacherId, onIdentityChanged }: { teacherId: string; onIdentityChanged?: () => void }) {
  const [configs, setConfigs] = useState<ProviderConfigDto[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [newDraft, setNewDraft] = useState(emptyNewDraft);
  const [showNew, setShowNew] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshLocked, setRefreshLocked] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const alive = useRef(true);
  const teacherRef = useRef(teacherId);
  const mutationEpoch = useRef(0);
  const busyRef = useRef(false);
  teacherRef.current = teacherId;
  const writesDisabled = capabilities?.configurationEnabled === false;

  function invalidateIdentity() {
    setConfigs([]); setCapabilities(null); setSelectedId(''); setDraft(null); setNewDraft(emptyNewDraft());
    setShowNew(false); setRefreshLocked(true); setError('当前登录身份已变化，请重新加载后再继续。');
    onIdentityChanged?.();
  }

  const load = useCallback(async (isRetry = false): Promise<boolean> => {
    const current = ++generation.current;
    if (isRetry) setLoading(true);
    setError('');
    try {
      const before = await me();
      if (!alive.current || current !== generation.current) return false;
      if (!before || before.id !== teacherId) { invalidateIdentity(); setLoading(false); return false; }
      const [nextConfigs, nextCapabilities] = await Promise.all([
        listProviderConfigs(teacherId),
        apiRequest<Capabilities>('/provider-configs/capabilities', { teacherId }),
      ]);
      if (!alive.current || current !== generation.current) return false;
      const after = await me();
      if (!alive.current || current !== generation.current) return false;
      if (!after || after.id !== teacherId) { invalidateIdentity(); setLoading(false); return false; }
      setConfigs(nextConfigs);
      setCapabilities(nextCapabilities);
      setSelectedId((previous) => nextConfigs.some((config) => config.id === previous) ? previous : (nextConfigs.find((config) => config.isPrimary)?.id ?? nextConfigs[0]?.id ?? ''));
      setRefreshLocked(false);
      setLoading(false);
      return true;
    } catch (failure) {
      if (!alive.current || current !== generation.current) return false;
      setLoading(false);
      setError(failure instanceof Error ? failure.message : '配置加载失败，请稍后重试。');
      return false;
    }
  }, [teacherId]);

  useEffect(() => {
    alive.current = true;
    teacherRef.current = teacherId;
    mutationEpoch.current += 1;
    busyRef.current = false;
    setSaving(false);
    setConfigs([]); setCapabilities(null); setSelectedId(''); setDraft(null); setNewDraft(emptyNewDraft());
    setShowNew(false); setNotice(''); setRefreshLocked(false); setLoading(true);
    void load();
    return () => { alive.current = false; generation.current += 1; };
  }, [load, teacherId]);

  const selected = configs.find((config) => config.id === selectedId) ?? null;
  const matchingModels = selected ? Array.from(new Set(configs.filter((config) => config.providerKind === selected.providerKind && config.baseUrl === selected.baseUrl).map((config) => config.model))) : [];
  const draftDirty = Boolean(selected && draft && (draft.displayName.trim() !== (selected.displayName ?? '') || draft.baseUrl.trim() !== selected.baseUrl || draft.model.trim() !== selected.model || draft.apiKey.trim()));
  useEffect(() => { setDraft(selected ? toDraft(selected) : null); }, [selectedId, selected?.updatedAtTs]);

  async function refreshAfterSave() { return load(true); }

  function beginMutation() {
    if (busyRef.current || saving || refreshLocked || writesDisabled) return null;
    busyRef.current = true;
    const token = { teacherId, epoch: ++mutationEpoch.current };
    setSaving(true); setNotice(''); setError('');
    return token;
  }

  function isCurrentMutation(token: { teacherId: string; epoch: number }) {
    return alive.current && teacherRef.current === token.teacherId && mutationEpoch.current === token.epoch;
  }

  async function verifyMutationIdentity(token: { teacherId: string; epoch: number }) {
    if (!isCurrentMutation(token)) return false;
    const identity = await me();
    if (!isCurrentMutation(token)) return false;
    if (!identity || identity.id !== token.teacherId) { invalidateIdentity(); return false; }
    return true;
  }

  function finishMutation(token: { teacherId: string; epoch: number }) {
    if (isCurrentMutation(token)) { busyRef.current = false; setSaving(false); }
  }

  function handleSelect(id: string) {
    if (id === selectedId) return;
    if (draftDirty) { setError('有未保存的编辑，请先保存或取消编辑。'); return; }
    setError(''); setSelectedId(id);
  }

  function openNewForm() {
    if (draftDirty) { setError('有未保存的编辑，请先保存或取消编辑。'); return; }
    setShowNew(true);
  }

  async function savePrimary() {
    if (!selected || selected.isPrimary || selected.status !== 'active') return;
    if (draftDirty) { setError('有未保存的编辑，请先保存或取消编辑。'); return; }
    const token = beginMutation();
    if (!token) return;
    try {
      if (!await verifyMutationIdentity(token)) return;
      await setPrimaryProviderConfig(teacherId, selected.id);
      if (!isCurrentMutation(token)) return;
      const refreshed = await refreshAfterSave();
      if (!isCurrentMutation(token)) return;
      if (refreshed) setNotice('默认模型已保存。');
      else { setRefreshLocked(true); setError('已保存，但最新配置加载失败。请先重新加载后再继续修改。'); }
    } catch (failure) { if (isCurrentMutation(token)) setError(failure instanceof Error ? failure.message : '保存失败，请稍后重试。'); }
    finally { finishMutation(token); }
  }

  async function saveSelected(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || !draft || saving || refreshLocked || writesDisabled) return;
    const validation = validateDraft(draft);
    if (validation) { setError(validation); return; }
    const body: { displayName?: string; baseUrl?: string; model?: string; apiKey?: string } = {};
    if (draft.displayName.trim() !== (selected.displayName ?? '')) body.displayName = draft.displayName.trim();
    if (draft.baseUrl.trim() !== selected.baseUrl) body.baseUrl = draft.baseUrl.trim();
    if (draft.model.trim() !== selected.model) body.model = draft.model.trim();
    if (draft.apiKey.trim()) body.apiKey = draft.apiKey.trim();
    if (!Object.keys(body).length) return;
    const token = beginMutation();
    if (!token) return;
    try {
      if (!await verifyMutationIdentity(token)) return;
      await updateProviderConfig(teacherId, selected.id, body);
      if (!isCurrentMutation(token)) return;
      setDraft((current) => current ? { ...current, apiKey: '' } : current);
      const refreshed = await refreshAfterSave();
      if (!isCurrentMutation(token)) return;
      if (refreshed) setNotice('配置已保存。');
      else { setRefreshLocked(true); setError('已保存，但最新配置加载失败。请先重新加载后再继续修改。'); }
    } catch (failure) { if (isCurrentMutation(token)) setError(failure instanceof Error ? failure.message : '保存失败，请稍后重试。'); }
    finally { finishMutation(token); }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (saving || refreshLocked || writesDisabled) return;
    const validation = validateDraft(newDraft, true);
    if (validation || !newDraft.providerName.trim()) { setError(validation || '请填写供应商名称。'); return; }
    const token = beginMutation();
    if (!token) return;
    try {
      if (!await verifyMutationIdentity(token)) return;
      await createProviderConfig(teacherId, { providerKind: newDraft.providerKind, providerName: newDraft.providerName.trim(), displayName: newDraft.displayName.trim() || undefined, baseUrl: newDraft.baseUrl.trim(), apiKey: newDraft.apiKey.trim(), model: newDraft.model.trim() });
      if (!isCurrentMutation(token)) return;
      setNewDraft(emptyNewDraft()); setShowNew(false);
      const refreshed = await refreshAfterSave();
      if (!isCurrentMutation(token)) return;
      if (refreshed) { setNewDraft(emptyNewDraft()); setShowNew(false); setNotice('API 配置已保存。'); }
      else { setRefreshLocked(true); setError('已保存，但最新配置加载失败。请先重新加载后再继续修改。'); }
    } catch (failure) { if (isCurrentMutation(token)) setError(failure instanceof Error ? failure.message : '保存失败，请稍后重试。'); }
    finally { finishMutation(token); }
  }

  if (loading) return <section className="model-configuration white-card settings-form"><h2>模型与 API</h2><p role="status">正在加载已保存的配置…</p></section>;
  if (error && !configs.length && !showNew) return <section className="model-configuration white-card settings-form"><h2>模型与 API</h2><p className="model-error" role="alert">{error}</p><button type="button" className="button primary" onClick={() => void load(true)}>重新加载</button></section>;

  return <section className="model-configuration settings-stack">
    <div className="white-card settings-form">
      <h2>已接入的模型服务</h2>
      <p>正式 AI 服务将由平台统一提供 DeepSeek。本页不会发起连接测试或真实模型调用；教师无需填写自己的 API Key。</p>
      {capabilities && !capabilities.configurationEnabled && <p className="model-state" role="status">当前账号暂不可修改 API 配置。</p>}
      {capabilities?.runtimeEnabled && <p className="model-state" role="status">模型运行能力已开启；本页仍只保存配置，不报告连接状态。</p>}
      {capabilities && !capabilities.runtimeEnabled && <p className="model-state" role="status">模型运行能力尚未开启；这里只保存兼容配置，暂不调用模型。</p>}
      {error && <p className="model-error" role="alert">{error}</p>}
      {notice && <p className="saved" role="status">{notice}</p>}
      {!configs.length && <div className="model-empty"><strong>当前账号还没有模型配置</strong><span>正式接入 DeepSeek 后，教师可直接使用；“添加 API”仅用于本地开发测试。</span><button type="button" className="button primary" onClick={() => setShowNew(true)} disabled={writesDisabled}>添加 API</button></div>}
      {configs.length > 0 && <>
        <fieldset className="model-list"><legend>已保存的配置</legend>{configs.map((config) => <label className="model-card" key={config.id}>
          <input type="radio" name="primary-provider" checked={selectedId === config.id} disabled={saving || config.status !== 'active'} onChange={() => handleSelect(config.id)} aria-label={`选择 ${config.displayName || config.providerName}`} />
          <span><strong>{config.displayName || config.providerName}</strong><small>{config.providerName} · {config.providerKind} · {config.model}</small><small>{config.isPrimary ? '默认模型 · ' : ''}{config.status === 'active' ? '可用配置' : '已停用'} · Key {config.apiKeyMasked || '未设置'}</small></span>
        </label>)}</fieldset>
        <div className="button-row"><button type="button" className="button primary" onClick={() => void savePrimary()} disabled={saving || refreshLocked || writesDisabled || draftDirty || !selected || selected.isPrimary || selected.status !== 'active'}>保存默认模型</button><button type="button" className="button secondary" onClick={() => handleSelect(configs.find((config) => config.isPrimary)?.id ?? selectedId)} disabled={saving || refreshLocked || !selected || selected.isPrimary}>取消默认选择</button><button type="button" className="button secondary" onClick={openNewForm} disabled={saving || refreshLocked || writesDisabled}>添加 API</button></div>
        {selected && draft && !showNew && <form className="model-edit" onSubmit={saveSelected}><h3>编辑配置</h3><label>显示名称<input disabled={saving} value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></label><label>API 地址<input disabled={saving} type="url" value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} /></label><label>模型 ID<input disabled={saving} list={`models-${selected.id}`} value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} required /><datalist id={`models-${selected.id}`}>{matchingModels.map((model) => <option value={model} key={model} />)}</datalist></label><label>替换 API Key（留空保留原 Key）<input disabled={saving} type="password" autoComplete="new-password" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} /></label><div className="button-row"><button type="button" className="button secondary" onClick={() => setDraft(toDraft(selected))} disabled={saving || !draftDirty}>取消编辑</button><button className="button primary" disabled={saving || refreshLocked || writesDisabled || !draftDirty}>保存配置</button></div></form>}
      </>}
      {refreshLocked && <button type="button" className="button secondary" onClick={() => void load(true)}>重新加载后解锁</button>}
    </div>
    {showNew && <form aria-label="添加 API 配置" className="white-card settings-form model-edit" onSubmit={create}><h2>添加 API（本地开发测试）</h2><p className="form-hint">正式 DeepSeek 服务由平台统一管理。此表单只用于本地开发测试，不要粘贴真实密钥。</p><label>协议<select disabled={saving} value={newDraft.providerKind} onChange={(event) => setNewDraft({ ...newDraft, providerKind: event.target.value as ProviderConfigKind })}><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic</option></select></label><label>供应商名称<input disabled={saving} value={newDraft.providerName} onChange={(event) => setNewDraft({ ...newDraft, providerName: event.target.value })} required /></label><label>显示名称<input disabled={saving} value={newDraft.displayName} onChange={(event) => setNewDraft({ ...newDraft, displayName: event.target.value })} /></label><label>API 地址<input disabled={saving} type="url" value={newDraft.baseUrl} onChange={(event) => setNewDraft({ ...newDraft, baseUrl: event.target.value })} required /></label><label>模型 ID<input disabled={saving} value={newDraft.model} onChange={(event) => setNewDraft({ ...newDraft, model: event.target.value })} required /></label><label>API Key<input disabled={saving} type="password" autoComplete="new-password" value={newDraft.apiKey} onChange={(event) => setNewDraft({ ...newDraft, apiKey: event.target.value })} required /></label><div className="button-row"><button type="button" className="button secondary" onClick={() => { setShowNew(false); setNewDraft(emptyNewDraft()); }} disabled={saving}>取消</button><button className="button primary" disabled={saving || refreshLocked || writesDisabled}>保存 API 配置</button></div></form>}
  </section>;
}
