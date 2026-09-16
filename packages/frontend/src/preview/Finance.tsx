import { FormEvent, useState } from 'react';
import { Payment, today as fallbackToday } from './data';
import { Confirm, PreviewActions, studentName } from './PreviewApp';
import { usePreviewState } from './ui-state';
import './finance.css';
import { formatDate } from '../shared/date-format';
import { commitAction } from './action-result';

export function FinancePage({ actions }: { actions: PreviewActions }) {
  const [studentId, setStudentId] = usePreviewState(actions, 'finance.studentId', '');
  const register = () => actions.open('登记缴费', <PaymentForm actions={actions} initialStudentId={studentId} />);
  const students = actions.data.students.filter((student) => !studentId || student.id === studentId);
  const records = actions.data.payments.filter((payment) => !studentId || payment.studentId === studentId);
  return <section className="page preview-page finance-page">
    <header className="page-header"><h1>缴费课时</h1><button className="button primary" onClick={register}>登记缴费</button></header>
    <label className="finance-filter">查看学生<select value={studentId} onChange={(event) => setStudentId(event.target.value)}><option value="">全部学生</option>{actions.data.students.map((student) => <option key={student.id} value={student.id}>{student.name}</option>)}</select></label>
    <div className="finance-stats" aria-label={studentId ? `${studentName(actions.data, studentId)}的课时概览` : '全部学生课时概览'}>
      <div><span>{studentId ? '当前学生' : '学生总数'}</span><strong>{studentId ? studentName(actions.data, studentId) : students.length}</strong></div>
      <div><span>{studentId ? '续费状态' : '待续费提醒'}</span><strong>{studentId ? students[0]?.balance <= 3 ? '待续费' : '充足' : students.filter((s) => s.balance <= 3).length}</strong></div>
      <div><span>缴费记录</span><strong>{records.length}</strong></div>
      <div><span>{studentId ? '剩余课时' : '剩余总课时'}</span><strong>{students.reduce((sum, student) => sum + student.balance, 0)}</strong></div>
    </div>
    {!records.length ? <div className="white-card finance-empty"><h2>暂无缴费记录</h2><p>{studentId ? `${studentName(actions.data, studentId)}还没有缴费记录。` : '登记第一笔缴费后，可在这里查看课时变化。'}</p><button className="button secondary" onClick={register}>登记第一笔缴费</button></div> : <div className="white-card schedule-table finance-table"><div className="schedule-table-scroll"><table><thead><tr><th>学生</th><th>金额</th><th>增加课时</th><th>登记日期</th></tr></thead><tbody>{records.map((payment) => <tr key={payment.id}><td data-label="学生">{studentName(actions.data, payment.studentId)}</td><td data-label="金额" className="money">¥{payment.amount}</td><td data-label="增加课时">+{payment.lessons}</td><td data-label="登记日期"><time dateTime={payment.date}>{formatDate(payment.date)}</time></td></tr>)}</tbody></table></div></div>}
  </section>;
}

type PaymentDraft = { studentId: string; amount: string; lessons: string };
function PaymentForm({ actions, initialStudentId = '', initialDraft }: { actions: PreviewActions; initialStudentId?: string; initialDraft?: PaymentDraft }) {
  const today = actions.data.businessDate || fallbackToday;
  const [draft, setDraft] = useState<PaymentDraft>(initialDraft || { studentId: initialStudentId, amount: '', lessons: '' });
  const [error, setError] = useState('');
  const { studentId, amount, lessons } = draft;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const student = actions.data.students.find((item) => item.id === studentId);
    if (!student || !Number.isFinite(Number(amount)) || Number(amount) <= 0 || !Number.isInteger(Number(lessons)) || Number(lessons) <= 0) { setError('请选择学生，填写有效金额和正整数课时。'); return; }
    const payment: Payment = { id: `p-${Date.now()}`, studentId, amount: Number(amount), lessons: Number(lessons), date: today };
    actions.open('确认登记缴费', <Confirm text={<>为 {student.name} 登记 ¥{payment.amount} / {payment.lessons} 课时。剩余课时：{student.balance} → {student.balance + payment.lessons}。</>} onCancel={() => actions.open('登记缴费', <PaymentForm actions={actions} initialDraft={draft} />)} onConfirm={() => commitAction(actions, () => actions.addPayment(payment), () => { actions.close(); actions.toast('缴费已登记，课时已更新'); })} label="确认登记" cancelLabel="返回修改" />);
  };
  return <form onSubmit={submit}><label>学生<select value={studentId} onChange={(event) => setDraft({ ...draft, studentId: event.target.value })} required><option value="">请选择</option>{actions.data.students.map((student) => <option key={student.id} value={student.id}>{student.name}</option>)}</select></label><label>金额<input type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value })} required /></label><label>增加课时<input type="number" min="1" step="1" value={lessons} onChange={(event) => setDraft({ ...draft, lessons: event.target.value })} required /></label>{error && <p role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="button secondary" onClick={actions.close}>取消</button><button className="button primary">下一步确认</button></div></form>;
}
