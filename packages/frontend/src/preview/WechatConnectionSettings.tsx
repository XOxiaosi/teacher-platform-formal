import { useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, QrCode, RefreshCw, Smartphone, Unplug } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { PreviewActions } from './PreviewApp';
import { usePreviewState } from './ui-state';

type ConnectionState = 'idle' | 'pending' | 'scanned' | 'connected' | 'expired' | 'failed' | 'cancelled';
const stateLabel: Record<ConnectionState, string> = {
  idle: '尚未连接', pending: '等待扫码（演示）', scanned: '已扫码，待手机确认（演示）', connected: '连接成功（演示）', expired: '二维码已过期（演示）', failed: '连接失败（演示）', cancelled: '已取消演示连接',
};

export function WechatConnectionSettings({ actions }: { actions: PreviewActions }) {
  const [connection, setConnection] = usePreviewState<ConnectionState>(actions, 'settings.wechat.connection', 'idle');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pairingCode, setPairingCode] = useState('');
  const completingDialog = useRef(false);
  const successfulClose = useRef(false);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const reconnectButtonRef = useRef<HTMLButtonElement>(null);
  const begin = () => { completingDialog.current = false; successfulClose.current = false; setPairingCode(''); setConnection('pending'); setDialogOpen(true); };
  const cancel = () => { setPairingCode(''); setConnection('cancelled'); setDialogOpen(false); };
  const finish = () => { completingDialog.current = true; successfulClose.current = true; setPairingCode(''); setConnection('connected'); setDialogOpen(false); };
  const advance = (next: ConnectionState) => { if (next !== 'scanned') setPairingCode(''); setConnection(next); };
  const closeChange = (open: boolean) => { setDialogOpen(open); if (!open && !completingDialog.current && connection !== 'connected') { setPairingCode(''); setConnection('cancelled'); } if (!open) completingDialog.current = false; };
  if (actions.connected) return <Card className="white-card settings-form wechat-connection"><CardContent>
    <div className="settings-card-heading"><div><Badge variant="secondary">通道尚未接入</Badge><h2>微信连接状态</h2></div><Smartphone size={20} aria-hidden="true" /></div>
    <p>微信连接服务尚未接入，暂无法获取连接状态。</p>
    <p className="settings-helper"><CircleAlert size={14} aria-hidden="true" />真实连接不等于消息已收发；收发结果仍需由服务端回执确认。</p>
    <Button type="button" variant="outline" disabled>扫码连接暂不可用</Button>
  </CardContent></Card>;
  return <><Card className="white-card settings-form wechat-connection"><CardContent>
    <div className="settings-card-heading"><div><Badge variant={connection === 'connected' ? 'default' : 'secondary'}>{stateLabel[connection]}</Badge><h2>连接微信</h2></div><QrCode size={20} aria-hidden="true" /></div>
    <p>连接后可在微信中继续已授权的教学工作。本预览只演示界面状态，不会生成真实二维码或连接账号。</p>
    <p className="settings-helper"><Smartphone size={14} aria-hidden="true" />同一部手机正在浏览此页时，请在电脑或另一块屏幕打开二维码，再用手机微信扫码。</p>
    {connection === 'connected' ? <><p className="connection-success" role="status"><CheckCircle2 size={16} aria-hidden="true" />连接成功（演示）· 真实收发未验证</p><div className="button-row"><Button type="button" variant="outline" onClick={() => { setPairingCode(''); setConnection('idle'); }}><Unplug size={15} />断开演示连接</Button><Button ref={reconnectButtonRef} type="button" onClick={begin}><RefreshCw size={15} />重新连接（演示）</Button></div></> : <div className="button-row"><Button ref={openButtonRef} type="button" onClick={begin}><QrCode size={16} />打开演示二维码</Button>{['expired', 'failed', 'cancelled'].includes(connection) && <Button type="button" variant="outline" onClick={begin}>重试演示连接</Button>}</div>}
  </CardContent></Card>
  <Dialog open={dialogOpen} onOpenChange={closeChange}><DialogContent className="wechat-qr-dialog" onCloseAutoFocus={event => { event.preventDefault(); const destination = successfulClose.current ? reconnectButtonRef : openButtonRef; setTimeout(() => { destination.current?.focus(); successfulClose.current = false; }, 0); }}>
    <DialogHeader><DialogTitle>连接微信（演示）</DialogTitle><DialogDescription>二维码仅为不可扫码占位；不会连接真实微信账号。</DialogDescription></DialogHeader>
    {connection === 'pending' && <><div className="demo-qr" aria-label="不可扫码的演示二维码占位"><QrCode size={100} aria-hidden="true" /><span>演示二维码</span></div><p className="connection-step" role="status">等待扫码（演示）。请用下面按钮推进状态。</p><DialogFooter><Button type="button" variant="outline" onClick={() => advance('expired')}>演示：二维码已过期</Button><Button type="button" variant="outline" onClick={() => advance('failed')}>演示：连接失败</Button><Button type="button" onClick={() => advance('scanned')}>演示：已扫码</Button></DialogFooter></>}
    {connection === 'scanned' && <><div className="connection-phone"><Smartphone size={25} aria-hidden="true" /><p role="status">已扫码，等待手机确认（演示）。</p></div><details className="pairing-code"><summary>手机要求输入配对码？（演示）</summary><label htmlFor="wechat-pairing-code">演示配对数字<Input id="wechat-pairing-code" inputMode="numeric" maxLength={8} value={pairingCode} onChange={event => setPairingCode(event.target.value.replace(/\D/g, ''))} placeholder="仅在需要时输入" /></label><span>可选步骤：数字只保存在当前演示界面，取消后清除。</span></details><DialogFooter><Button type="button" variant="outline" onClick={() => advance('failed')}>演示：连接失败</Button><Button type="button" onClick={finish}>演示：手机已确认</Button></DialogFooter></>}
    {connection === 'expired' && <><p className="connection-step connection-error" role="status">二维码已过期（演示），请刷新后重新扫码。</p><DialogFooter><Button type="button" onClick={() => advance('pending')}><RefreshCw size={15} />刷新演示二维码</Button></DialogFooter></>}
    {connection === 'failed' && <><p className="connection-step connection-error" role="status">连接失败（演示），未创建真实连接。</p><DialogFooter><Button type="button" onClick={() => advance('pending')}><RefreshCw size={15} />重试演示连接</Button></DialogFooter></>}
    {connection === 'connected' && <><p className="connection-success" role="status"><CheckCircle2 size={16} aria-hidden="true" />连接成功（演示）· 真实收发未验证</p><DialogFooter><Button type="button" onClick={() => setDialogOpen(false)}>完成</Button></DialogFooter></>}
    {connection !== 'connected' && <Button type="button" variant="ghost" className="cancel-demo-connection" onClick={cancel}>取消演示连接</Button>}
  </DialogContent></Dialog></>;
}
