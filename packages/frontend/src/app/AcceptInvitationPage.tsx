import { FormEvent, useEffect, useState } from 'react';
import { ArrowRight, BookOpen, CalendarDays, GraduationCap, LoaderCircle, MessageSquare, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { acceptInvitation } from '../api/auth';

export function invitationTokenFromLocation(locationLike: Pick<Location, 'hash'> = window.location): string {
  const hash = locationLike.hash;
  const tokenPart = hash.startsWith('#/') ? hash.slice(hash.indexOf('#', 2) + 1) : hash.slice(1);
  if (!tokenPart || tokenPart === hash) return '';
  const params = new URLSearchParams(tokenPart);
  return params.get('token')?.trim() ?? '';
}

function clearInvitationToken() {
  const cleanUrl = `${window.location.pathname}${window.location.search}`;
  window.history.replaceState(null, '', cleanUrl);
}

export function AcceptInvitationPage({ onAccepted }: { onAccepted: () => Promise<void> }) {
  // Lazy initialization runs before either StrictMode effect pass, so the
  // credential survives React's development-only effect replay after the URL
  // has been scrubbed.
  const [token] = useState(invitationTokenFromLocation);
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) setError('邀请链接无效或已失效，请让管理员重新发送邀请。');
    // The invitation credential is removed before the user can submit or navigate.
    if (token) clearInvitationToken();
  }, [token]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (!token) {
      setError('邀请链接无效或已失效，请让管理员重新发送邀请。');
      return;
    }
    if (password !== confirmPassword) {
      setError('两次输入的密码不一致，请重新确认。');
      return;
    }
    setBusy(true);
    try {
      await acceptInvitation({ token, displayName: displayName.trim(), password });
      await onAccepted();
    } catch (acceptError) {
      setError(acceptError instanceof Error ? acceptError.message : '接受邀请失败，请稍后重试。');
    } finally {
      setBusy(false);
    }
  };

  return <main className="auth-shell auth-redesign">
    <aside className="auth-story">
      <a href="#/today" className="auth-brand"><GraduationCap size={30} /><span>教师工作室<small>TEACHING WORKSPACE</small></span></a>
      <div className="auth-story-content"><span className="auth-eyebrow">欢迎加入你的教学工作空间</span><h2>让教学更从容。<br /><span>让成长有迹可循。</span></h2><p>把记录、排课和家长沟通放在同一个空间，<br />留出更多时间，关注每一位学生。</p><div className="auth-features"><span><MessageSquare size={18} />AI 教学助手</span><span><CalendarDays size={18} />课程与日程</span><span><BookOpen size={18} />学生成长档案</span></div></div>
      <p className="auth-story-footer">专为个人教师设计的日常工作空间</p>
    </aside>
    <section className="auth-login-area"><div className="auth-login-wrap"><p className="auth-kicker">接受教师邀请</p><h1 id="invitation-title">创建你的工作空间</h1><p className="auth-intro">设置显示名称和密码，开始使用教师工作台。</p>
      <Card className="auth-card"><CardContent><form onSubmit={submit} aria-labelledby="invitation-title">
        <label htmlFor="invitation-display-name">显示名称<Input id="invitation-display-name" autoComplete="name" placeholder="例如：张老师" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></label>
        <label htmlFor="invitation-password">密码<Input id="invitation-password" type="password" autoComplete="new-password" placeholder="至少 8 位字符" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} required /></label>
        <label htmlFor="invitation-confirm-password">确认密码<Input id="invitation-confirm-password" type="password" autoComplete="new-password" placeholder="再次输入密码" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={8} required /></label>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <Button disabled={busy || !token} className="auth-submit">{busy ? <LoaderCircle className="animate-spin" /> : null}{busy ? '创建中…' : '接受邀请并进入工作台'}{!busy && <ArrowRight size={17} />}</Button>
      </form></CardContent></Card>
      <p className="auth-note"><ShieldCheck size={15} />邀请链接仅用于创建你的教师账号。</p>
    </div></section>
  </main>;
}
