/* UI-012 prototype: compare three layouts for the existing Today page with synthetic, in-memory states. */
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, CalendarDays, CheckCircle2, CircleAlert, Clock3, FileCheck2, Inbox, MapPin, MessageSquareText, Plus, Sparkles } from 'lucide-react';
import { Dialog } from './Chrome';
import './today-prototype.css';

type Variant = 'A' | 'B' | 'C';
type Scenario = 'normal' | 'review' | 'empty' | 'failure';
type Course = { id: string; time: string; end: string; student: string; place: string; status: '待上课' | '已完成' | '已取消' };
type Material = { id: string; student: string; source: string; time: string; original: string; candidate: string; status: '待核对' | '需补充' | '失败' | '已记录' };
type Sample = { courses: Course[]; materials: Material[]; memo: string[] };

const variantNames: Record<Variant, string> = { A: '日程优先', B: '任务优先', C: '时间轴' };
const scenarioNames: Record<Scenario, string> = { normal: '正常工作日', review: '待核对较多', empty: '没有事项', failure: '处理失败' };
const variants: Variant[] = ['A', 'B', 'C'];
const scenarios: Scenario[] = ['normal', 'review', 'empty', 'failure'];
const courseOne: Course = { id: 'c1', time: '09:00', end: '11:00', student: '林同学', place: '线上', status: '已完成' };
const courseTwo: Course = { id: 'c2', time: '14:00', end: '16:00', student: '陈同学', place: '教室 A', status: '待上课' };
const courseThree: Course = { id: 'c3', time: '19:00', end: '21:00', student: '小班 · 3 人', place: '待补充地点', status: '待上课' };
const courseCancelled: Course = { id: 'c4', time: '17:00', end: '18:00', student: '周同学', place: '教室 B', status: '已取消' };
const materialOne: Material = { id: 'm1', student: '林同学', source: '微信转述', time: '10:42', original: '家长说这周做题更愿意讲思路了。', candidate: '家长反馈：本周做题时更愿意说明思路。', status: '待核对' };
const materialTwo: Material = { id: 'm2', student: '待确认学生', source: '文字材料', time: '11:18', original: '今天的分数比上次高一些，名字我稍后补。', candidate: '本次测评分数可能提高；学生身份与具体分数待补充。', status: '需补充' };
const materialFailed: Material = { id: 'm3', student: '陈同学', source: '微信转述', time: '12:05', original: '今天想先练习上次错题。', candidate: '拟记录内容仍保留，尚未保存。', status: '失败' };
const materialRecorded: Material = { id: 'm4', student: '周同学', source: '文字材料', time: '09:30', original: '今天课堂上主动提出了一个新解法。', candidate: '教师观察：本次课堂主动提出了新的解题方法。', status: '已记录' };
const samples: Record<Scenario, Sample> = {
  normal: { courses: [courseOne, courseTwo, courseCancelled, courseThree], materials: [materialOne, materialRecorded], memo: ['提醒陈同学带上次练习册'] },
  review: { courses: [courseTwo], materials: [materialOne, materialTwo], memo: ['核对两条学生情况'] },
  empty: { courses: [], materials: [], memo: [] },
  failure: { courses: [courseTwo], materials: [materialFailed], memo: [] },
};
const activeCourses = (sample: Sample) => sample.courses.filter((course) => course.status !== '已取消');
const actionableMaterials = (sample: Sample) => sample.materials.filter((material) => material.status !== '已记录');

function readChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const value = new URLSearchParams(location.search).get(key);
  return allowed.find((item) => item === value) ?? fallback;
}
function writeChoice(variant: Variant, scenario: Scenario) {
  const url = new URL(location.href);
  url.searchParams.set('prototype', 'today');
  url.searchParams.set('variant', variant);
  url.searchParams.set('state', scenario);
  history.replaceState(null, '', url);
}
function dateLabel() { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date()); }

function PrototypeHeader({ onNotice }: { onNotice: (message: string) => void }) {
  return <header className="tp-header"><div><p className="tp-eyebrow">我的今天 · {dateLabel()}（演示日期）</p><h1>今日工作台</h1><p>先看清今天要做的事，再进入课程或核对材料。</p></div><div className="tp-header-actions"><button type="button" className="tp-button tp-primary" onClick={() => onNotice('排课入口样板：正式操作请在日程安排中完成。')}><Plus size={16} />安排课程</button><button type="button" className="tp-button tp-outline" onClick={() => onNotice('教学助手入口样板：这里不会发送消息。')}><Sparkles size={16} />问教学助手</button></div></header>;
}
function Counts({ sample }: { sample: Sample }) {
  const planned = sample.courses.filter((course) => course.status === '待上课').length;
  const pending = sample.materials.filter((item) => item.status === '待核对' || item.status === '需补充').length;
  return <div className="tp-counts" aria-label="今日概览"><div><CalendarDays size={18} /><strong>{activeCourses(sample).length}</strong><span>今日课程</span></div><div><Clock3 size={18} /><strong>{planned}</strong><span>待上课程</span></div><div><Inbox size={18} /><strong>{pending}</strong><span>待核对材料</span></div></div>;
}
function CourseRow({ course, onOpen }: { course: Course; onOpen: (course: Course) => void }) {
  return <button type="button" className="tp-course-row" onClick={() => onOpen(course)}><span className="tp-course-time"><strong>{course.time}</strong><small>{course.end}</small></span><span className="tp-course-person"><strong>{course.student}</strong><small><MapPin size={13} />{course.place}</small></span><span className={`tp-status ${course.status === '已完成' ? 'tp-done' : course.status === '已取消' ? 'tp-cancelled' : 'tp-planned'}`}>{course.status}</span><ArrowRight size={16} className="tp-row-arrow" aria-hidden="true" /></button>;
}
function MaterialRow({ material, onOpen }: { material: Material; onOpen: (material: Material) => void }) {
  const stateClass = material.status === '失败' ? 'tp-failed' : material.status === '已记录' ? 'tp-done' : 'tp-review';
  const action = material.status === '失败' ? '查看原因与重试' : material.status === '已记录' ? '查看记录详情' : '查看并核对';
  const saved = material.status === '已记录' ? '教学记录已保存' : material.status === '失败' ? '保存失败，原话已保留' : '教学记录未保存';
  const reply = material.source === '微信转述' ? '微信回复未发送' : '无需微信回复';
  return <button type="button" className="tp-material-row" onClick={() => onOpen(material)}><span className="tp-material-top"><strong>{material.student}</strong><span className={`tp-status ${stateClass}`}>{material.status}</span></span><small>{material.source} · {material.time}</small><span className="tp-material-quote">“{material.original}”</span><span className="tp-material-state">{saved} · {reply}</span><span className="tp-material-action">{action} <ArrowRight size={14} /></span></button>;
}
function EmptyBlock({ kind, onNotice }: { kind: 'course' | 'material'; onNotice: (message: string) => void }) {
  return <div className="tp-empty"><CheckCircle2 size={24} /><strong>{kind === 'course' ? '今天暂无课程安排' : '当前没有待核对材料'}</strong><p>{kind === 'course' ? '需要上课时，可以从日程安排新增课程。' : '新收到的材料会在这里等待你核对。'}</p>{kind === 'course' && <button type="button" className="tp-text-button" onClick={() => onNotice('排课入口样板：正式操作请在日程安排中完成。')}>去安排课程 <ArrowRight size={14} /></button>}</div>;
}

function VariantA({ sample, openCourse, openMaterial, notice }: { sample: Sample; openCourse: (course: Course) => void; openMaterial: (material: Material) => void; notice: (message: string) => void }) {
  const courses = activeCourses(sample);
  const cancelled = sample.courses.filter((course) => course.status === '已取消');
  return <>
    <Counts sample={sample} />
    <div className="tp-layout-a">
      <section className="tp-panel tp-agenda">
        <div className="tp-section-title"><div><span className="tp-kicker">今天的节奏</span><h2>今日课程</h2></div><span>{courses.length} 节</span></div>
        {courses.length ? courses.map((course) => <CourseRow key={course.id} course={course} onOpen={openCourse} />) : <EmptyBlock kind="course" onNotice={notice} />}
        {cancelled.length > 0 && <details className="tp-cancelled-list"><summary>已取消课程 · {cancelled.length}</summary>{cancelled.map((course) => <CourseRow key={course.id} course={course} onOpen={openCourse} />)}</details>}
      </section>
      <aside className="tp-panel tp-side">
        <div className="tp-section-title"><div><span className="tp-kicker">需要留意</span><h2>学生情况</h2></div><span>{actionableMaterials(sample).length} 项待处理</span></div>
        {sample.materials.length ? sample.materials.map((material) => <MaterialRow key={material.id} material={material} onOpen={openMaterial} />) : <EmptyBlock kind="material" onNotice={notice} />}
        {sample.memo.length > 0 && <div className="tp-memo"><strong>备忘</strong>{sample.memo.map((memo) => <p key={memo}>{memo}</p>)}</div>}
      </aside>
    </div>
    <section className="tp-section-note"><MessageSquareText size={18} /><p>微信录入的学生情况会先进入待核对材料；核对并保存后才进入正式记录。</p></section>
  </>;
}
function VariantB({ sample, openCourse, openMaterial, notice }: { sample: Sample; openCourse: (course: Course) => void; openMaterial: (material: Material) => void; notice: (message: string) => void }) {
  const planned = sample.courses.filter((course) => course.status === '待上课');
  const materials = actionableMaterials(sample);
  const courses = activeCourses(sample);
  const cancelled = sample.courses.filter((course) => course.status === '已取消');
  return <div className="tp-layout-b">
    <section className="tp-panel tp-command">
      <div className="tp-section-title"><div><span className="tp-kicker">先处理这些</span><h2>下一步行动</h2></div><strong>{materials.length + planned.length} 项</strong></div>
      {materials.length === 0 && planned.length === 0 ? <div className="tp-empty"><CheckCircle2 size={24} /><strong>目前没有需要处理的事项</strong><p>可以查看今天的课程，或开始新的教学工作。</p></div> : <div className="tp-action-list">
        {materials.map((material) => <button type="button" className="tp-action" key={material.id} onClick={() => openMaterial(material)}><span className="tp-action-icon"><FileCheck2 size={19} /></span><span><small>{material.status} · {material.source}</small><strong>{material.student}的学生情况</strong><em>{material.original}</em></span><ArrowRight size={17} /></button>)}
        {planned.map((course) => <button type="button" className="tp-action" key={course.id} onClick={() => openCourse(course)}><span className="tp-action-icon"><CalendarDays size={19} /></span><span><small>待上课 · {course.time}</small><strong>{course.student}的课程</strong><em>{course.place}</em></span><ArrowRight size={17} /></button>)}
      </div>}
    </section>
    <aside className="tp-panel tp-day-card"><div className="tp-section-title"><div><span className="tp-kicker">一眼看完</span><h2>今天的课程</h2></div></div>
      {courses.length ? courses.map((course) => <CourseRow key={course.id} course={course} onOpen={openCourse} />) : <EmptyBlock kind="course" onNotice={notice} />}
      {cancelled.length > 0 && <details className="tp-cancelled-list"><summary>已取消课程 · {cancelled.length}</summary>{cancelled.map((course) => <CourseRow key={course.id} course={course} onOpen={openCourse} />)}</details>}
      <div className="tp-day-total">待处理材料 <strong>{materials.length}</strong> 项</div>
    </aside>
  </div>;
}
function VariantC({ sample, openCourse, openMaterial, notice }: { sample: Sample; openCourse: (course: Course) => void; openMaterial: (material: Material) => void; notice: (message: string) => void }) {
  return <div className="tp-layout-c"><section className="tp-time-rail"><div className="tp-section-title"><div><span className="tp-kicker">按时间推进</span><h2>今天的时间轴</h2></div><span>{activeCourses(sample).length} 节课程</span></div>{sample.courses.length ? sample.courses.map((course) => <div className="tp-time-slot" key={course.id}><span className="tp-rail-time">{course.time}</span><span className="tp-rail-dot" /><div className="tp-panel"><CourseRow course={course} onOpen={openCourse} /></div></div>) : <EmptyBlock kind="course" onNotice={notice} />}</section><aside className="tp-rail-side"><div className="tp-panel"><div className="tp-section-title"><div><span className="tp-kicker">随时处理</span><h2>学生情况</h2></div><span>{actionableMaterials(sample).length} 项待处理</span></div>{sample.materials.length ? sample.materials.map((material) => <MaterialRow key={material.id} material={material} onOpen={openMaterial} />) : <EmptyBlock kind="material" onNotice={notice} />}</div>{sample.memo.length > 0 && <div className="tp-panel tp-memo"><strong>备忘</strong>{sample.memo.map((memo) => <p key={memo}>{memo}</p>)}</div>}</aside></div>;
}

function PrototypeSwitch({ variant, scenario, onVariant, onScenario }: { variant: Variant; scenario: Scenario; onVariant: (value: Variant) => void; onScenario: (value: Scenario) => void }) {
  const move = (step: number) => onVariant(variants[(variants.indexOf(variant) + step + variants.length) % variants.length]);
  return <nav className="tp-switch" aria-label="工作台样板切换"><span className="tp-switch-label">布局</span><button type="button" aria-label="上一种布局" onClick={() => move(-1)}><ArrowLeft size={17} /></button><strong>{variant} · {variantNames[variant]}</strong><button type="button" aria-label="下一种布局" onClick={() => move(1)}><ArrowRight size={17} /></button><span className="tp-switch-divider" /><label>情境 <select aria-label="样板情境" value={scenario} onChange={(event) => onScenario(event.target.value as Scenario)}>{scenarios.map((item) => <option key={item} value={item}>{scenarioNames[item]}</option>)}</select></label></nav>;
}

export function TodayPrototype() {
  const [variant, setVariant] = useState<Variant>(() => readChoice('variant', variants, 'A'));
  const [scenario, setScenario] = useState<Scenario>(() => readChoice('state', scenarios, 'normal'));
  const [detail, setDetail] = useState<Course | Material | null>(null);
  const [notice, setNotice] = useState('');
  const [handled, setHandled] = useState<string[]>([]);
  const sample = samples[scenario];
  const changeVariant = (value: Variant) => { setVariant(value); writeChoice(value, scenario); };
  const changeScenario = (value: Scenario) => { setScenario(value); setDetail(null); setHandled([]); setNotice(''); writeChoice(variant, value); };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (detail) return;
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const step = event.key === 'ArrowRight' ? 1 : -1;
      setVariant((current) => {
        const next = variants[(variants.indexOf(current) + step + variants.length) % variants.length];
        writeChoice(next, scenario);
        return next;
      });
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [scenario, detail]);
  const openCourse = (course: Course) => { setNotice(''); setDetail(course); };
  const openMaterial = (material: Material) => { setNotice(''); setDetail(material); };
  const isMaterial = detail !== null && 'original' in detail;
  const completeDemo = () => {
    if (!detail) return;
    if ('original' in detail && detail.status === '已记录') { setDetail(null); return; }
    setHandled((current) => [...current, detail.id]);
    setNotice('样板操作已演示；没有写入正式资料。');
    setDetail(null);
  };
  return <section className={`page preview-page today-prototype tp-variant-${variant.toLowerCase()}`}><div className="tp-review-banner"><CircleAlert size={16} /><span>UI-012 设计样板 · 合成资料 · 页面操作不保存</span></div><PrototypeHeader onNotice={setNotice} />{variant === 'A' && <VariantA sample={sample} openCourse={openCourse} openMaterial={openMaterial} notice={setNotice} />}{variant === 'B' && <VariantB sample={sample} openCourse={openCourse} openMaterial={openMaterial} notice={setNotice} />}{variant === 'C' && <VariantC sample={sample} openCourse={openCourse} openMaterial={openMaterial} notice={setNotice} />}{handled.length > 0 && <p className="tp-handled" role="status">本页已演示处理 {handled.length} 项，刷新后重置。</p>}{notice && <p className="tp-toast" role="status">{notice}<button type="button" onClick={() => setNotice('')} aria-label="关闭提示">×</button></p>}<PrototypeSwitch variant={variant} scenario={scenario} onVariant={changeVariant} onScenario={changeScenario} />{detail && <Dialog title={isMaterial ? '核对学生情况 · 样板' : '课程详情 · 样板'} onClose={() => setDetail(null)}><div className="tp-detail">{isMaterial ? <><p className="tp-detail-meta">{detail.student} · {detail.source} · {detail.time}</p><h3>收到的原话</h3><blockquote>{detail.original}</blockquote><h3>拟记录内容</h3><p>{detail.candidate}</p><p className="tp-detail-hint">记录状态：{detail.status === '已记录' ? '已保存' : detail.status === '失败' ? '保存失败' : '未保存'}；{detail.source === '微信转述' ? '微信回复：未发送' : '无需微信回复'}。正式使用时，需要核对学生归属和内容，保存结果以实际回执为准。</p></> : <><p className="tp-detail-meta">{detail.time}–{detail.end} · {detail.student} · {detail.place}</p><p>当前状态：{detail.status}</p><p className="tp-detail-hint">正式完课时需核对出勤和课时变化；本样板只展示入口与确认位置。</p></>}<div className="tp-detail-actions"><button type="button" className="tp-button tp-outline" onClick={() => setDetail(null)}>返回工作台</button><button type="button" className="tp-button tp-primary" onClick={completeDemo}>{isMaterial ? (detail.status === '失败' ? '演示重试' : detail.status === '已记录' ? '关闭详情' : '演示核对') : '演示进入处理'}</button></div></div></Dialog>}</section>;
}
