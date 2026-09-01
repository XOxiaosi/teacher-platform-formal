import { FormEvent, useEffect, useState } from 'react';
import { createPayment, listPayments } from '../../api/payments';
import { getStudentBalance, listStudents } from '../../api/students';
import type { LessonBalance, PaymentData, StudentData } from '../../api/types';
import { formatDate } from '../../shared/date-format';
import { formatCurrency, formatLessonCount } from '../../shared/number-format';
import './payments.css';

interface PaymentsPageProps {
  teacherId: string;
}

interface PaymentFormState {
  studentId: string;
  amount: string;
  lessonCount: string;
  paidAt: string;
  note: string;
}

const initialFormState: PaymentFormState = {
  studentId: '',
  amount: '',
  lessonCount: '',
  paidAt: '',
  note: '',
};

export function PaymentsPage({ teacherId }: PaymentsPageProps) {
  const [payments, setPayments] = useState<PaymentData[]>([]);
  const [students, setStudents] = useState<StudentData[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<PaymentFormState>(initialFormState);
  const [balance, setBalance] = useState<LessonBalance | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    Promise.all([listPayments(teacherId), listStudents(teacherId)])
      .then(([paymentResult, studentResult]) => {
        if (!active) return;
        setPayments(paymentResult.items);
        setStudents(studentResult.items);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setLoadError(messageOf(error));
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => { active = false; };
  }, [teacherId]);

  useEffect(() => {
    const studentId = form.studentId.trim();
    if (!studentId) {
      setBalance(null);
      setBalanceError(null);
      return;
    }
    const guard = { active: true };
    refreshBalance(studentId, guard);
    return () => { guard.active = false; };
  }, [form.studentId, teacherId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setCreateError(null);
    const studentId = form.studentId.trim();

    try {
      const created = await createPayment(teacherId, {
        studentId,
        amount: Number(form.amount),
        lessonCount: Number(form.lessonCount),
        paidAt: form.paidAt,
        note: form.note.trim() || undefined,
      });
      setPayments((current) => [created, ...current]);
      setForm({ ...initialFormState, studentId });
      await refreshBalance(studentId, { active: true });
    } catch (error) {
      setCreateError(messageOf(error));
    } finally {
      setSaving(false);
    }
  }

  async function refreshBalance(studentId: string, guard: { active: boolean }) {
    setBalance(null);
    setBalanceError(null);
    try {
      const nextBalance = await getStudentBalance(teacherId, studentId);
      if (guard.active) setBalance(nextBalance);
    } catch (error) {
      if (guard.active) setBalanceError(messageOf(error));
    }
  }

  function updateField(field: keyof PaymentFormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  if (loading) {
    return <section className="payments-page page-card">正在加载缴费记录</section>;
  }

  if (loadError) {
    return (
      <section className="payments-page page-card payments-error" role="alert">
        <p className="eyebrow">Error</p>
        <h2>缴费记录加载失败</h2>
        <p>{loadError}</p>
      </section>
    );
  }

  return (
    <section className="payments-page">
      <header className="page-hero">
        <p className="eyebrow">课时财务</p>
        <h2>缴费课时</h2>
        <p>记录学生缴费金额与购买课时，作为后续课时余额计算的输入。</p>
      </header>

      <form className="page-card payment-form" onSubmit={handleSubmit}>
        <h3>新增缴费</h3>
        <div className="payment-form-grid">
          <label htmlFor="payment-student-id">
            学生
            <select
              id="payment-student-id"
              value={form.studentId}
              onChange={(event) => updateField('studentId', event.target.value)}
              required
            >
              <option value="">请选择学生</option>
              {students.map((student) => <option key={student.id} value={student.id}>{student.name} · {student.grade}</option>)}
            </select>
          </label>
          <label htmlFor="payment-amount">
            缴费金额
            <input
              id="payment-amount"
              type="number"
              min="0"
              step="0.01"
              value={form.amount}
              onChange={(event) => updateField('amount', event.target.value)}
              required
            />
          </label>
          <label htmlFor="payment-lesson-count">
            课时数
            <input
              id="payment-lesson-count"
              type="number"
              min="0"
              step="0.5"
              value={form.lessonCount}
              onChange={(event) => updateField('lessonCount', event.target.value)}
              required
            />
          </label>
          <label htmlFor="payment-paid-at">
            缴费日期
            <input
              id="payment-paid-at"
              type="date"
              value={form.paidAt}
              onChange={(event) => updateField('paidAt', event.target.value)}
              required
            />
          </label>
        </div>
        <label htmlFor="payment-note">
          备注
          <textarea
            id="payment-note"
            value={form.note}
            onChange={(event) => updateField('note', event.target.value)}
            placeholder="例如：暑期班、补课包"
          />
        </label>
        <BalancePreview balance={balance} error={balanceError} hasStudent={Boolean(form.studentId.trim())} />
        {createError ? <p className="payments-form-error" role="alert">新增失败：{createError}</p> : null}
        <button className="primary-action" type="submit" disabled={saving}>
          {saving ? '保存中' : '新增缴费'}
        </button>
      </form>

      <article className="page-card payments-list-card">
        <h3>缴费记录列表</h3>
        {payments.length === 0 ? <p className="muted">暂无缴费记录。</p> : <PaymentsTable payments={payments} />}
      </article>
    </section>
  );
}

function BalancePreview({ balance, error, hasStudent }: { balance: LessonBalance | null; error: string | null; hasStudent: boolean }) {
  if (!hasStudent) return null;
  if (error) return <p className="payments-form-error" role="alert">余额加载失败：{error}</p>;
  if (!balance) return <p className="muted">正在加载余额预览</p>;
  return (
    <section className="payment-balance-preview" aria-label="余额预览">
      <h4>余额预览</h4>
      <div className="payment-balance-grid">
        <BalanceMetric label="购买课时" value={balance.purchased} />
        <BalanceMetric label="已消耗" value={balance.attended} />
        <BalanceMetric label="剩余课时" value={balance.remaining} />
      </div>
    </section>
  );
}

function BalanceMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="payment-balance-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PaymentsTable({ payments }: { payments: PaymentData[] }) {
  return (
    <div className="payments-table-wrap">
      <table className="payments-table">
        <thead>
          <tr>
            <th scope="col">学生</th>
            <th scope="col">金额</th>
            <th scope="col">购买课时</th>
            <th scope="col">缴费日期</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((payment) => (
            <tr key={payment.id}>
              <td data-label="学生">{payment.studentId}</td>
              <td data-label="金额">{formatCurrency(payment.amount)}</td>
              <td data-label="购买课时">{formatLessonCount(payment.lessonCount)}</td>
              <td data-label="缴费日期">{formatDate(payment.paidAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
