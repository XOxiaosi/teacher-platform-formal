import type { DemoData } from '../../preview/data';
import type { AssistantTransport } from './transport';

interface Props {
  data?: DemoData;
  transport?: AssistantTransport;
}

function todayInShanghai() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function countToday(data?: DemoData) {
  const day = data?.businessDate ?? todayInShanghai();
  return data?.schedules.filter((schedule) => schedule.day === day && schedule.status !== '已取消').length ?? 0;
}

export function AssistantDashboard({ data, transport }: Props) {
  const todayLessons = countToday(data);
  const pendingMemos = data?.memos.filter((memo) => !memo.done).length ?? 0;
  const drafts = data?.feedbacks.filter((feedback) => feedback.status === '草稿' || !feedback.status).length ?? 0;
  const completedLessons = data?.schedules.filter((schedule) => schedule.status === '已完成').length ?? 0;
  const available = transport?.runtimeAvailability === 'available';
  const testing = transport?.runtimeAvailability === 'test_only';

  return <section className="assistant-dashboard" aria-label="工作看板">
    <div className="assistant-dashboard-heading">
      <div><span className="assistant-eyebrow">今天先看</span><h2>工作看板</h2></div>
      <a href="#/today">查看全部</a>
    </div>
    <p className={`assistant-dashboard-status ${available ? 'is-ready' : ''}`} role="status">
      <span aria-hidden="true" className="assistant-dashboard-dot" />
      {available ? 'AI 服务可用' : testing ? 'AI 服务处于测试模式' : 'AI 服务尚不可用'}
    </p>
    <div className="assistant-dashboard-stats">
      <a href="#/today"><strong>{todayLessons}</strong><span>今日课程</span></a>
      <a href="#/captures"><strong>{pendingMemos}</strong><span>待补充</span></a>
      <a href="#/feedback"><strong>{drafts}</strong><span>待核对</span></a>
      <a href="#/today"><strong>{completedLessons}</strong><span>最近完成</span></a>
    </div>
    <div className="assistant-dashboard-links">
      <a href="#/captures"><span>待核对材料</span><small>整理后再归档</small></a>
      <a href="#/students"><span>学生档案</span><small>查看资料与课时</small></a>
      <a href="#/schedules"><span>课程安排</span><small>确认今天和接下来</small></a>
    </div>
    {data?.students?.length ? <div className="assistant-dashboard-students">
      <h3>最近学生</h3>
      <ul>{data.students.slice(0, 3).map((student) => <li key={student.id}><a href={`#/students/${encodeURIComponent(student.id)}`}><span>{student.name}</span><small>{student.grade} · 余 {student.balance} 课时</small></a></li>)}</ul>
    </div> : null}
  </section>;
}
