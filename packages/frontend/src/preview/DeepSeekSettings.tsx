import { FormEvent, useState } from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

/** Preview-only configuration surface. The key never leaves this component. */
export function DeepSeekSettings() {
  const [apiKey, setApiKey] = useState('');
  const [notice, setNotice] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setApiKey('');
    setNotice('演示配置已清空，未保存或验证 API Key。');
  };
  return <Card className="white-card settings-form deepseek-settings"><CardContent><form onSubmit={submit}>
    <div className="settings-card-heading"><div><Badge variant="secondary">DSH</Badge><h2>DeepSeek 演示配置</h2></div><KeyRound size={20} aria-hidden="true" /></div>
    <p>此预览只展示 DSH 连接 DeepSeek 的单一密钥入口，不会保存、发送或验证输入内容。</p>
    <div className="dsh-path" aria-label="DSH 到 DeepSeek 的演示连接路径"><span>DSH</span><i aria-hidden="true" /> <span>DeepSeek</span></div>
    <label htmlFor="deepseek-api-key">DeepSeek API Key<Input id="deepseek-api-key" type="password" autoComplete="off" spellCheck="false" value={apiKey} onChange={event => { setApiKey(event.target.value); setNotice(''); }} placeholder="仅用于演示，不会保存" /></label>
    <p className="settings-helper"><ShieldCheck size={14} aria-hidden="true" />提交后立即清空。正式服务由平台统一提供；此页尚未连接真实服务。</p>
    <div className="button-row"><Button type="submit" disabled={!apiKey.trim()}>提交演示配置</Button></div>
    {notice && <p className="saved" role="status">{notice}</p>}
  </form></CardContent></Card>;
}
