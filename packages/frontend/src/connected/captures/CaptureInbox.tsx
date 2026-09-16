import { useEffect, useRef, useState } from 'react';
import { getCapture, listCaptures, type CaptureRecord } from '../../api/captures';
import { CandidateCard, type CaptureStudent } from './CandidateCard';
import { retainOnlyTeacherCaptureDrafts } from './drafts';
import './captures.css';
import { formatDateTime } from '../../shared/date-format';

interface Props { teacherId: string; students: CaptureStudent[]; onRecordsChanged?: () => Promise<void> }
function AccountCaptureInbox({ teacherId, students, onRecordsChanged }: Props) {
  const [items, setItems] = useState<CaptureRecord[]>([]);
  const [selected, setSelected] = useState<CaptureRecord | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const active = useRef(true);
  async function refresh() {
    const current = ++epoch.current; setBusy(true); setError('');
    try {
      const next: CaptureRecord[] = []; const seen = new Set<string>(); let cursor: string | undefined;
      do {
        const page = await listCaptures(cursor);
        next.push(...page.items);
        if (!page.nextCursor) break;
        if (seen.has(page.nextCursor)) throw new Error('材料列表加载未完成，请重试。');
        seen.add(page.nextCursor); cursor = page.nextCursor;
      } while (true);
      if (active.current && current === epoch.current) { setItems([...new Map(next.map((v) => [v.id, v])).values()]); setSelected((old) => old ? next.find((v) => v.id === old.id) ?? null : null); }
    } catch (failure) {
      if (active.current && current === epoch.current) setError(failure instanceof Error ? failure.message : '材料加载失败');
      throw failure;
    } finally { if (active.current && current === epoch.current) setBusy(false); }
  }
  useEffect(() => { retainOnlyTeacherCaptureDrafts(teacherId); }, [teacherId]);
  useEffect(() => { active.current = true; void refresh().catch(() => {}); return () => { active.current = false; epoch.current += 1; }; }, []);
  async function open(id: string) {
    const current = ++epoch.current; setBusy(true); setError('');
    try { const capture = await getCapture(id); if (active.current && current === epoch.current) setSelected(capture); }
    catch (failure) { if (active.current && current === epoch.current) setError(failure instanceof Error ? failure.message : '材料加载失败'); }
    finally { if (active.current && current === epoch.current) setBusy(false); }
  }
  async function refreshAfterChange() {
    await refresh();
    if (!active.current || !onRecordsChanged) return;
    try { await onRecordsChanged(); }
    catch {
      if (active.current) setError('操作已保存，学生档案暂未刷新。请使用“刷新资料”查看最新记录，无需重复确认。');
    }
  }
  return <section className="page capture-inbox" aria-label="待核对材料">
    <header><h1>待核对材料</h1><p>已提交的文字材料保存在这里，可逐项核对；暂留或拒绝不会归入正式档案。</p>
      <div className="button-row"><button className="button secondary" disabled={busy} onClick={() => void refresh().catch(() => {})}>刷新材料</button><a className="button secondary" href="#/students">记录学生情况</a><a href="#/agent">返回教学助手</a></div>
    </header>
    {error && <p role="alert">{error}</p>}{busy && <p role="status">正在加载材料…</p>}
    {!busy && !error && items.length === 0 && <p>还没有已提交材料。可从学生档案记录学生情况。</p>}
    <div className="capture-layout"><nav aria-label="材料列表">{items.map((item) => {
      const candidates = item.candidates ?? [item.candidate];
      const pending = candidates.filter((v) => v.reviewStatus === 'pending' || v.reviewStatus === 'deferred').length;
      return <button key={item.id} className="capture-list-item" disabled={busy} aria-current={selected?.id === item.id ? 'true' : undefined} onClick={() => void open(item.id)}><span>{item.rawText.slice(0, 70)}</span><small>{pending ? `${pending} 项待核对` : '核对已处理'} · {candidates.length} 项</small></button>;
      })}</nav>{selected && <section aria-label="材料详情"><h2>核对材料</h2><p>提交时间：{formatDateTime(selected.createdAt)}（北京时间）</p><h3>原始内容</h3><p className="capture-raw">{selected.rawText}</p>
      {(selected.candidates ?? [selected.candidate]).map((item) => <CandidateCard key={`${selected.id}:${item.id}`} teacherId={teacherId} item={item} captureId={selected.id} students={students} onChange={refreshAfterChange} />)}
    </section>}</div>
  </section>;
}

export function CaptureInbox(props: Props) {
  return <AccountCaptureInbox key={props.teacherId} {...props} />;
}
