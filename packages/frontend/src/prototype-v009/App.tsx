import { useEffect, useRef, useState } from 'react';
import { Dialog, Icon } from '../preview/Chrome';
import { SchedulePage } from './Schedule';
import { courseObject, createStudio, DEMO_DAY, type Candidate, type ScheduleRequest, type Studio, type StudioProps } from './model';

type FeedbackTarget = { studentId:string; courseId?:string };
type Page = 'desk' | 'students' | 'schedule' | 'review' | 'feedback' | 'account';
const pages: { id: Page; title: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
  { id:'desk', title:'工作台', icon:'ai' }, { id:'students', title:'学生', icon:'students' }, { id:'schedule', title:'排课', icon:'schedule' },
  { id:'review', title:'待核对', icon:'today' }, { id:'feedback', title:'家长反馈', icon:'feedback' }, { id:'account', title:'我的', icon:'settings' },
];
function readPage(): Page { const key = location.hash.slice(2); return pages.some(p=>p.id===key) ? key as Page : 'desk'; }
function go(page: Page) { location.hash = '/'+page; }
export function App() {
  const [data,setData] = useState<Studio>(createStudio);
  const [page,setPage] = useState<Page>(readPage);
  const mainRef=useRef<HTMLElement>(null);
  useEffect(()=>{mainRef.current?.scrollTo?.({top:0});},[page]);
  const [notice,notify] = useState('');
  const [request,setRequest] = useState<ScheduleRequest>();
  const [feedbackTarget,setFeedbackTarget]=useState<FeedbackTarget>();
  useEffect(()=>{if(page!=='feedback')setFeedbackTarget(undefined);},[page]);
  useEffect(()=>{if(page!=='schedule')setRequest(undefined);},[page]);
  const [chatText,setChatText] = useState('');
  const [requests,setRequests] = useState<string[]>([]);
  useEffect(()=>{ const handler = ()=>setPage(readPage()); addEventListener('hashchange',handler); return ()=>removeEventListener('hashchange',handler); },[]);
  useEffect(()=>{ if(!notice)return; const timer=setTimeout(()=>notify(''),5500); return ()=>clearTimeout(timer); },[notice]);
  const pending = data.candidates.filter(c=>c.status==='pending').length;
  const props: StudioProps = {data,setData,notify};
  const openFeedback=(studentId:string,courseId?:string)=>{setFeedbackTarget({studentId,courseId});go('feedback');};
  const schedule = (mode:ScheduleRequest['mode'],courseId?:string)=> { setRequest({key:Date.now(),mode,courseId});go('schedule'); };
  return <div className="v9-app">
    <aside className="v9-sidebar">
      <a className="v9-brand" href="#/desk"><span>思</span><div>小思教师工作台<small>把时间留给教学</small></div></a>
      <nav aria-label="主要导航">{pages.map(p=><a href={'#/'+p.id} key={p.id} aria-current={page===p.id?'page':undefined}><Icon name={p.icon}/><span>{p.title}</span>{p.id==='review'&&pending>0&&<b>{pending}</b>}</a>)}</nav>
      <div className="v9-profile"><span className="v9-avatar">刘</span><div>刘老师<small>个人工作空间</small></div></div>
    </aside>
    <main className="v9-main" ref={mainRef}>
      <header className="v9-topbar"><span>{pages.find(p=>p.id===page)?.title}</span><span className="v9-muted">2026 年 9 月 14 日 · 北京时间</span></header>
      <div className="v9-content">
      {page==='desk'&&<>
        <div className="v9-heading"><div className="v9-eyebrow">TEACHING STUDIO</div><h1>刘老师，今天从哪件事开始？</h1><p>接着处理手边的工作，每一步都有结果可看。</p></div>
        <div className="v9-desk-grid">
          <section className="v9-conversation" aria-label="教学助手">
            <div className="v9-assistant-intro"><span className="v9-assistant-mark"><Icon name="ai"/></span><div><h2>你的教学助手</h2><p>学生、课程、教学记录和家长沟通，都可以从这里开始。</p></div></div>
            <div className="v9-task-grid">
              <button onClick={()=>schedule('backfill')}><Icon name="schedule"/><b>补录昨晚的课程</b><span>核对时间、出勤与课时</span></button>
              <button onClick={()=>go('review')}><Icon name="today"/><b>核对小雨的课后记录</b><span>{pending} 条内容等待你确认</span></button>
              <button onClick={()=>schedule('complete','c1')}><Icon name="finance"/><b>核对这节课的课时</b><span>先看出勤和余额变化</span></button>
              <button onClick={()=>openFeedback('s1','c1')}><Icon name="feedback"/><b>准备小雨的课后反馈</b><span>从已确认记录形成完整材料</span></button>
            </div>
            <div className="v9-recent-task"><div className="v9-row"><span className="v9-pill">{pending?'待你核对':'核对已完成'}</span><small>林小雨 · 9 月 14 日课后记录</small></div><p>{pending?'这份待核对材料包含教师观察、家长反馈、学生自述和下一步计划。计划尚未实施，暂不写入效果。':'材料的核对状态已更新，可以在学生档案查看正式记录，并继续准备家长反馈。'}</p><button className="v9-text-button" onClick={()=>go(pending?'review':'students')}>{pending?'查看原文与候选':'查看学生档案'} <span aria-hidden="true">→</span></button></div>
            {requests.map((text,i)=><div className="v9-chat-exchange" key={i}><p className="v9-user-message">{text}</p><p>当前 AI 服务尚未连接，这条请求还未处理。输入已保留，你可以从上方入口继续办理教学工作。</p></div>)}
            <form className="v9-composer" onSubmit={event=>{event.preventDefault();if(!chatText.trim())return;setRequests(old=>[...old,chatText.trim()]);setChatText('');}}>
              <textarea aria-label="告诉助手你想完成的工作" placeholder="告诉我你想完成什么，例如：把小雨周三的课改到周五下午……" value={chatText} onChange={e=>setChatText(e.target.value)}/>
              <div className="v9-row"><span className="v9-muted">学生管理 · 教学记录 · 课后反馈</span><button className="v9-button" disabled={!chatText.trim()} type="submit">发送</button></div>
            </form>
          </section>
          <aside className="v9-day-panel">
            <div className="v9-row"><h2>今天的安排</h2><button className="v9-text-button" onClick={()=>go('schedule')}>查看课表</button></div>
            {data.courses.filter(c=>c.day===DEMO_DAY&&c.status!=='cancelled').map(c=><article className="v9-day-course" key={c.id}><time>{c.start} — {c.end}</time><h3>{courseObject(c,data.students)}</h3><p>{c.location}</p><button className="v9-text-button" disabled={c.status==='completed'} onClick={()=>schedule('complete',c.id)}>{c.status==='completed'?'已完课':'核对并完课'}</button></article>)}
            <button className="v9-button secondary v9-full" onClick={()=>schedule('add')}>增加课程</button>
            <div className="v9-small-note"><h3>工作接续</h3><p>待核对 {pending} 项 · 已确认 {data.candidates.filter(c=>c.status==='confirmed').length} 条记录</p><button className="v9-text-button" onClick={()=>go('review')}>继续核对</button></div>
          </aside>
        </div>
      </>}
      {page==='schedule'&&<SchedulePage {...props} request={request}/>}
      {page==='review'&&<ReviewPage {...props} openFeedback={openFeedback}/>}
      {page==='students'&&<StudentsPage {...props}/>}
      {page==='feedback'&&<FeedbackPage {...props} target={feedbackTarget}/>}
      {page==='account'&&<AccountPage notify={notify}/>}
      </div>
    </main>
    {notice&&<div className="v9-toast" role="status">{notice}</div>}
  </div>;
}

export function ReviewPage({data,setData,notify,openFeedback}:StudioProps & {openFeedback?:(studentId:string,courseId?:string)=>void}) {
  const [selected,setSelected] = useState('r1');
  const item=data.candidates.find(c=>c.id===selected)!;
  const [draft,setDraft]=useState<Candidate>(item);
  useEffect(()=>setDraft(item),[item]);
  const updateDraft=(next:Candidate)=>{setDraft(next);setData(old=>({...old,candidates:old.candidates.map(c=>c.id===next.id&&c.status==='pending'?next:c)}));};
  const save = (status:Candidate['status'])=>{
    if(status==='confirmed'&&!draft.text.trim()){notify('请补全拟保存内容。');return;}
    setData(old=>({...old,candidates:old.candidates.map(c=>c.id===item.id?{...draft,text:draft.text.trim(),status}:c)}));
    notify(status==='confirmed'?'这条记录已确认，可以在学生档案查看。':'已拒绝这条候选，原始材料仍保留。');
    const next=data.candidates.find(c=>c.status==='pending'&&c.id!==item.id);if(next)setSelected(next.id);
  };
  return <><div className="v9-heading"><div className="v9-eyebrow">REVIEW</div><h1>把记录核对清楚</h1><p>一边看原文，一边确认。每一条内容由你决定是否保存。</p></div>
    <div className="v9-review-tabs" role="group" aria-label="选择候选">{data.candidates.map((c,index)=><button key={c.id} aria-pressed={selected===c.id} onClick={()=>setSelected(c.id)}><span>{String(index+1).padStart(2,'0')}</span>{c.speaker}<small>{c.status==='pending'?'待核对':c.status==='confirmed'?'已确认':'已拒绝'}</small></button>)}</div>
    <div className="v9-review-grid">
      <section className="v9-source"><div className="v9-row"><h2>原始材料</h2><span className="v9-pill">文字记录</span></div><p className="v9-source-text">{item.source}</p><p className="v9-muted">林小雨 · 2026 年 9 月 14 日</p><div className="v9-rule"><b>先保留表达者，再判断内容</b><p>家长反映的情况不等于已经核实的事实；下一步计划也不等于已发生的效果。</p></div></section>
      <section className="v9-paper"><div className="v9-row"><h2>拟保存内容</h2><span className="v9-pill">{item.status==='pending'?'尚未存为正式记录':item.status==='confirmed'?'正式记录':'已拒绝'}</span></div>
        <fieldset disabled={item.status!=='pending'}>
          <div className="v9-form-two"><label>所属学生<select value={draft.studentId} onChange={e=>updateDraft({...draft,studentId:e.target.value,courseId:undefined})}>{data.students.map(s=><option key={s.id} value={s.id}>{s.name} · {s.grade}</option>)}</select></label><label>信息来源<select value={draft.speaker} onChange={e=>updateDraft({...draft,speaker:e.target.value})}>{['教师观察','家长反馈','学生自述','教师方案','已采取措施','实际反应'].map(s=><option key={s}>{s}</option>)}</select></label></div>
          <label>记录内容<textarea rows={5} value={draft.text} onChange={e=>updateDraft({...draft,text:e.target.value})}/></label>
          {draft.uncertainty&&<p className="v9-caution">待核对：{draft.uncertainty}</p>}
          <label className="v9-check"><input type="checkbox" checked={draft.share} onChange={e=>updateDraft({...draft,share:e.target.checked})}/>允许将这条已确认记录用于家长材料</label>
        </fieldset>
        {item.status==='pending'?<div className="v9-actions"><button className="v9-button" onClick={()=>save('confirmed')}>确认这一条</button><button className="v9-button secondary" onClick={()=>save('rejected')}>拒绝</button><button className="v9-text-button" onClick={()=>{setData(old=>({...old,candidates:old.candidates.map(c=>c.id===item.id?{...draft,status:'pending'}:c)}));notify('已暂留修改，仍待核对。');go('desk');}}>暂留，稍后处理</button></div>:<div className="v9-actions"><button className="v9-button secondary" onClick={()=>go('students')}>查看学生档案</button><button className="v9-button" onClick={()=>openFeedback?openFeedback(item.studentId,item.courseId):go('feedback')}>准备家长反馈</button></div>}
      </section>
    </div>
  </>;
}

function StudentsPage({data,setData,notify}:StudioProps) {
  const [studentId,setStudentId]=useState('s1');
  const [search,setSearch]=useState('');
  const [adding,setAdding]=useState(false);
  const [name,setName]=useState('');
  const [grade,setGrade]=useState('');
  const student=data.students.find(s=>s.id===studentId)!;
  const records=data.candidates.filter(c=>c.studentId===studentId&&c.status==='confirmed');
  return <><div className="v9-heading v9-row"><div><div className="v9-eyebrow">STUDENTS</div><h1>每个学生，持续了解</h1><p>课程、记录与课时在同一份档案中接续。</p></div><button className="v9-button" onClick={()=>setAdding(true)}>新建学生</button></div>
    <div className="v9-students-grid"><aside><label>查找学生<input value={search} onChange={e=>setSearch(e.target.value)} placeholder="输入姓名"/></label><div className="v9-student-list">{data.students.filter(s=>s.name.includes(search)).map(s=><button aria-pressed={s.id===studentId} key={s.id} onClick={()=>setStudentId(s.id)}><span className="v9-avatar">{s.name.slice(-2)}</span><div><b>{s.name}</b><small>{s.grade} · 剩余 {s.balance} 课时</small></div></button>)}</div></aside>
      <section className="v9-paper"><div className="v9-row"><div><h2>{student.name}</h2><p className="v9-muted">{student.grade}</p></div><span className="v9-balance">{student.balance}<small>剩余课时</small></span></div><h3 className="v9-section-title">已经确认的教学记录</h3>
        {records.length?records.map(r=><article className="v9-record" key={r.id}><div className="v9-row"><b>{r.speaker}</b><span className="v9-muted">{r.occurredOn}</span></div><p>{r.text}</p><small>{r.share?'允许用于家长材料':'仅教师内部使用'}</small><details><summary>查看原始依据</summary><p>{r.source}</p></details></article>):<div className="v9-empty"><p>还没有已确认的教学记录。</p><button className="v9-button secondary" onClick={()=>go('review')}>去核对材料</button></div>}
        <h3 className="v9-section-title">课时变化</h3>{data.ledger.filter(e=>e.studentId===studentId).length?data.ledger.filter(e=>e.studentId===studentId).map(e=><div key={e.id} className="v9-ledger-line"><span>{e.day} · {e.attended?'出勤':'缺席'}</span><b>{e.amount>0?'-'+e.amount:'0'} 课时</b><span>{e.before} → {e.after}</span></div>):<p className="v9-muted">当前没有新增扣课记录。</p>}
      </section></div>
    {adding&&<Dialog title="新建学生" onClose={()=>setAdding(false)}><form onSubmit={e=>{e.preventDefault();if(!name.trim()||!grade.trim())return;const id='s-'+Date.now();setData(old=>({...old,students:[...old.students,{id,name:name.trim(),grade:grade.trim(),balance:0}]}));setStudentId(id);setAdding(false);setName('');setGrade('');notify('学生已建立，尚无课时变动。');}}><label>学生姓名<input required value={name} onChange={e=>setName(e.target.value)}/></label><label>年级<input required value={grade} onChange={e=>setGrade(e.target.value)}/></label><button className="v9-button" type="submit">确认新建</button></form></Dialog>}
  </>;
}

export function FeedbackPage({data,setData,notify,target}:StudioProps & {target?:FeedbackTarget}) {
  const initialStudent=target?.studentId||data.feedback?.studentId||'s1';
  const initialCourse=target?(target.courseId||''):(data.feedback?.courseId||'c1');
  const initial=data.feedbacks[initialStudent+':'+(initialCourse||'unlinked-'+DEMO_DAY)];
  const [studentId,setStudentId]=useState(initialStudent);
  const [text,setText]=useState(initial?.text||'');
  const [sourceIds,setSourceIds]=useState<string[]>(initial?.sourceIds||[]);
  // Keep edits in the current browser session until the teacher explicitly
  // saves a draft or confirms it. This map is not the canonical feedback store.
  const [localDrafts,setLocalDrafts]=useState<Record<string,{text:string;sourceIds:string[]}>>({});
  const [courseId,setCourseId]=useState(initialCourse);
  const [replacing,setReplacing]=useState(false);
  const [showSources,setShowSources]=useState(false);
  const student=data.students.find(s=>s.id===studentId)!;
  const selectedCourse=data.courses.find(c=>c.id===courseId);
  const occurredOn=selectedCourse?.day||DEMO_DAY;
  const scopeKey=(student:string,course:string)=>student+':'+(course||'unlinked-'+DEMO_DAY);
  const setLocalDraft=(key:string,value:{text:string;sourceIds:string[]})=>setLocalDrafts(old=>({...old,[key]:value}));
  const loadScope=(student:string,course:string)=>{const key=scopeKey(student,course);const value=localDrafts[key]||data.feedbacks[key];setStudentId(student);setCourseId(course);setText(value?.text||'');setSourceIds(value?.sourceIds||[]);};
  const records=data.candidates.filter(c=>c.studentId===studentId&&c.courseId===(courseId||undefined)&&c.occurredOn===occurredOn&&c.status==='confirmed'&&c.share);
  const saved=data.feedbacks[scopeKey(studentId,courseId)];
  const reviewed=saved?.status==='reviewed'&&saved.text===text;
  const save = (status:'draft'|'reviewed')=>{if(!text.trim()){notify('请先准备反馈正文。');return;}const value={studentId,courseId:courseId||undefined,occurredOn,text:text.trim(),sourceIds,status};setData(old=>({...old,feedback:value,feedbacks:{...old.feedbacks,[scopeKey(studentId,courseId)]:value}}));setLocalDrafts(old=>{const next={...old};delete next[scopeKey(studentId,courseId)];return next;});notify(status==='reviewed'?'反馈已核对。你可以复制后自行发给家长。':'反馈草稿已保存。');};
  const prepare = ()=>{if(!records.length)return;const value=`${student.name}家长您好，和您同步本次课后情况。\n\n${records.map(r=>r.text).join('\n\n')}\n\n以上是本次已有记录的整理，我们会在后续课堂继续关注。`;setText(value);setSourceIds(records.map(r=>r.id));setLocalDraft(scopeKey(studentId,courseId),{text:value,sourceIds:records.map(r=>r.id)});notify('已根据允许对家长表达的记录准备草稿，请核对正文后明确保存。');};
  return <><div className="v9-heading"><div className="v9-eyebrow">PARENT FEEDBACK</div><h1>让家长看到有依据的变化</h1><p>准备本次课后反馈，核对后由你发送。</p></div>
    <div className="v9-feedback-grid"><aside className="v9-paper"><h2>这次反馈写给谁</h2><label>学生<select value={studentId} onChange={e=>loadScope(e.target.value,data.courses.find(c=>c.studentIds.includes(e.target.value)&&c.status!=='cancelled')?.id||'')}>{data.students.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label>课程与记录范围<select value={courseId} onChange={e=>loadScope(studentId,e.target.value)}>{data.courses.filter(c=>c.studentIds.includes(studentId)&&c.status!=='cancelled').map(c=><option key={c.id} value={c.id}>{c.day} {c.start}–{c.end} · {c.location}</option>)}<option value="">未关联课程 · {DEMO_DAY}</option></select></label><p className="v9-muted">范围：{occurredOn} · {selectedCourse?selectedCourse.start+'–'+selectedCourse.end:'未关联课程的记录'}</p><div className="v9-rule"><b>{records.length} 条记录可用于家长材料</b><p>只使用已确认且允许对家长表达的内容。内部记录不进入正文。</p></div><button className="v9-button v9-full" onClick={()=>text.trim()?setReplacing(true):prepare()} disabled={!records.length}>根据记录准备反馈</button>{!records.length&&<button className="v9-text-button" onClick={()=>go('review')}>先去核对教学记录 →</button>}<p className="v9-muted">也可以直接编写反馈正文。</p><button className="v9-text-button" onClick={()=>setShowSources(!showSources)}>{showSources?'收起依据':'查看可用依据'}</button>{showSources&&records.map(r=><p key={r.id} className="v9-source-snippet"><b>{r.speaker}</b><br/>{r.text}</p>)}</aside>
      <section className="v9-paper v9-feedback-paper"><div className="v9-row"><h2>课后反馈正文</h2><span className="v9-pill">{reviewed?'已核对':'草稿'}</span></div><textarea aria-label="课后反馈正文" className="v9-feedback-text" value={text} onChange={e=>{const next=e.target.value;setText(next);setLocalDraft(scopeKey(studentId,courseId),{text:next,sourceIds});}} placeholder="在这里编写，或先核对记录，再根据记录准备反馈……"/>
        <div className="v9-actions"><button className="v9-button" onClick={()=>save('reviewed')} disabled={!text.trim()}>确认已核对</button><button className="v9-button secondary" onClick={()=>save('draft')} disabled={!text.trim()}>保存草稿</button><button className="v9-button secondary" disabled={!text.trim()} onClick={async()=>{try{await navigator.clipboard.writeText(text);notify('正文已复制，请由你自行发送给家长。');}catch{notify('复制未成功，请选中正文手工复制。');}}}>复制正文</button></div><p className="v9-muted">复制不会标记为已发送，也不会自动联系家长。</p>{sourceIds.length>0&&<details><summary>本份草稿使用的依据（{sourceIds.length} 条）</summary>{sourceIds.map(id=>{const source=data.candidates.find(c=>c.id===id);return <p key={id} className="v9-source-snippet">{source?source.speaker+'：'+source.text:'依据已不可用，请重新核对'}</p>;})}</details>}
      </section></div>
    {replacing&&<Dialog title="重新准备反馈" onClose={()=>setReplacing(false)}><p>将根据当前课程的可用记录替换正文。你已修改的文字会被替换。</p><div className="v9-actions"><button className="v9-button secondary" onClick={()=>setReplacing(false)}>保留现有正文</button><button className="v9-button" onClick={()=>{prepare();setReplacing(false);}}>确认重新准备</button></div></Dialog>}
  </>;
}

function AccountPage({notify}:{notify:(text:string)=>void}) { return <><div className="v9-heading"><div className="v9-eyebrow">ACCOUNT</div><h1>你的工作空间</h1><p>账号、AI 服务与微信连接。</p></div><div className="v9-account-grid"><section className="v9-paper"><h2>AI 服务</h2><p>由平台统一提供 DeepSeek 服务，教师无需配置 API Key。</p><div className="v9-row"><span>当前连接</span><span className="v9-pill">尚未连接</span></div><p className="v9-muted">教学资料仍可手工查看、录入与核对。</p></section><section className="v9-paper"><h2>连接微信</h2><p>关联后，通过与助手私聊接续同一个教师工作空间。</p><div className="v9-row"><span>当前账号</span><span className="v9-pill">未连接</span></div><button className="v9-button secondary" onClick={()=>notify('微信连接服务尚未开通，当前不能生成有效连接码。')}>查看连接状态</button></section></div></>; }
