import { FormEvent, useEffect, useState } from 'react';
import { ArrowRight, BookOpen, CalendarDays, GraduationCap, LoaderCircle, MessageSquare, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { login } from '../api/auth';

export function LoginPage({ error: initialError, onRetry }: { error?: string | null; onRetry: () => Promise<void> }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState(initialError || ''); const [busy, setBusy] = useState(false);
  useEffect(() => { setError(initialError || ''); }, [initialError]);
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(''); setBusy(true); try { await login({ email: email.trim(), password }); await onRetry(); } catch (loginError) { setError(loginError instanceof Error ? loginError.message : '登录失败，请重试。'); } finally { setBusy(false); } };
  return <main className="auth-shell auth-redesign"><aside className="auth-story">
    <a href="#/today" className="auth-brand"><GraduationCap size={30} /><span>教师工作室<small>TEACHING WORKSPACE</small></span></a>
    <div className="auth-story-content"><span className="auth-eyebrow">每一堂课，都值得被认真记录</span><h2>让教学更从容。<br /><span>让成长有迹可循。</span></h2><p>把记录、排课和家长沟通放在同一个空间，<br />留出更多时间，关注每一位学生。</p><div className="auth-features"><span><MessageSquare size={18} />AI 教学助手</span><span><CalendarDays size={18} />课程与日程</span><span><BookOpen size={18} />学生成长档案</span></div></div>
    <p className="auth-story-footer">专为个人教师设计的日常工作空间</p>
  </aside><section className="auth-login-area"><div className="auth-login-wrap"><p className="auth-kicker">欢迎回来</p><h1 id="login-title">开启今天的教学工作</h1><p className="auth-intro">登录你的个人教师工作空间。</p>
    <Card className="auth-card"><CardContent><form onSubmit={submit} aria-labelledby="login-title"><label htmlFor="login-email">邮箱<Input id="login-email" type="email" autoComplete="username" placeholder="输入你的邮箱" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label htmlFor="login-password">密码<Input id="login-password" type="password" autoComplete="current-password" placeholder="输入登录密码" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>{error && <p className="auth-error" role="alert">{error}</p>}<Button disabled={busy} className="auth-submit">{busy ? <LoaderCircle className="animate-spin" /> : null}{busy ? '登录中…' : '登录'}{!busy && <ArrowRight size={17} />}</Button></form></CardContent></Card>
    <p className="auth-note"><ShieldCheck size={15} />仅限受邀教师使用，不开放公共注册。</p><Button variant="ghost" className="auth-retry" onClick={() => void onRetry()}>重试连接</Button>
  </div></section></main>;
}
