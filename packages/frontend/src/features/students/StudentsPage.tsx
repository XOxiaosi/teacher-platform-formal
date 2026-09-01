import { FormEvent, useEffect, useLayoutEffect, useState } from 'react';
import { createStudent, getStudentBalance, listStudents } from '../../api/students';
import type { LessonBalance, StudentData } from '../../api/types';
import { studentStatusLabel } from '../../shared/display-labels';
import './students.css';

interface StudentsPageProps {
  teacherId: string;
  focusedStudentId?: string;
  onNavigate?: (path: string) => void;
}

interface StudentFormState {
  name: string;
  grade: string;
  source: string;
  stageGoal: string;
}

const emptyForm: StudentFormState = {
  name: '',
  grade: '',
  source: '',
  stageGoal: '',
};

export function StudentsPage({ teacherId, focusedStudentId, onNavigate }: StudentsPageProps) {
  const [students, setStudents] = useState<StudentData[]>([]);
  const [selectedStudent, setSelectedStudent] = useState<StudentData | null>(null);
  const [balance, setBalance] = useState<LessonBalance | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<StudentFormState>(emptyForm);
  const [createMessage, setCreateMessage] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    setStudents([]);
    setSelectedStudent(null);
    listStudents(teacherId)
      .then((result) => {
        if (!active) return;
        setStudents(result.items);
        setSelectedStudent((current) => keepSelectedStudent(current, result.items));
      })
      .catch((error: unknown) => {
        if (!active) return;
        setLoadError(messageOf(error));
        setStudents([]);
        setSelectedStudent(null);
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });
    return () => { active = false; };
  }, [teacherId]);

  useLayoutEffect(() => {
    if (!focusedStudentId) return;
    setSelectedStudent(students.find((student) => student.id === focusedStudentId) ?? null);
  }, [focusedStudentId, students]);

  useEffect(() => {
    if (!selectedStudent) {
      setBalance(null);
      setBalanceError(null);
      return;
    }
    let active = true;
    setBalance(null);
    setBalanceError(null);
    getStudentBalance(teacherId, selectedStudent.id)
      .then((nextBalance) => {
        if (!active) return;
        setBalance(nextBalance);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setBalanceError(messageOf(error));
      });
    return () => { active = false; };
  }, [selectedStudent, teacherId]);

  async function handleCreateStudent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = normalizeForm(form);
    if (!payload.name || !payload.grade) {
      setCreateError('姓名和年级必填');
      setCreateMessage(null);
      return;
    }

    setCreating(true);
    setCreateError(null);
    setCreateMessage(null);
    try {
      const created = await createStudent(teacherId, payload);
      setStudents((current) => [created, ...current.filter((student) => student.id !== created.id)]);
      setSelectedStudent(created);
      setForm(emptyForm);
      setShowForm(false);
      setCreateMessage('学生已创建');
    } catch (error) {
      setCreateError(`创建失败：${messageOf(error)}`);
    } finally {
      setCreating(false);
    }
  }

  const filteredStudents = students.filter((student) => {
    const term = search.trim().toLowerCase();
    if (!term) return true;
    return student.name.toLowerCase().includes(term) || student.grade.toLowerCase().includes(term);
  });

  if (loading) {
    return <section className="students-page page-card">正在加载学生列表</section>;
  }

  if (loadError) {
    return (
      <section className="students-page page-card danger-card" aria-live="polite">
        <p className="eyebrow">Error</p>
        <h2>学生列表加载失败</h2>
        <p>{loadError}</p>
      </section>
    );
  }

  return (
    <section className="students-page">
      <header className="page-hero">
        <p className="eyebrow">学生档案</p>
        <h2>学生中心</h2>
        <p>管理学生基础档案，并快速查看当前学习目标。</p>
      </header>

      <div className="students-layout">
        <article className="page-card students-list-card">
          <div className="students-card-header">
            <h3>学生列表</h3>
            <span>{students.length} 人</span>
          </div>
          <input
            className="search-input"
            type="search"
            placeholder="搜索学生姓名或年级"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {students.length === 0 ? <EmptyStudents /> : filteredStudents.length === 0 ? <SearchEmpty /> : <StudentList students={filteredStudents} selectedStudentId={selectedStudent?.id ?? null} onSelect={setSelectedStudent} onNavigate={onNavigate} />}
        </article>

        <div className="students-side-panel">
          {showForm ? (
            <CreateStudentForm form={form} creating={creating} message={createMessage} error={createError} onChange={setForm} onSubmit={handleCreateStudent} onCancel={() => { setShowForm(false); setForm(emptyForm); }} />
          ) : (
            <>
              {createMessage ? <p className="students-message success">{createMessage}</p> : null}
              {createError ? <p className="students-message danger">{createError}</p> : null}
              <button className="primary-action students-toggle-form" type="button" onClick={() => { setShowForm(true); setCreateMessage(null); setCreateError(null); }}>新增学生</button>
            </>
          )}
          <StudentProfile student={selectedStudent} balance={balance} balanceError={balanceError} />
        </div>
      </div>
    </section>
  );
}

function EmptyStudents() {
  return (
    <div className="empty-state">
      <h3>还没有学生档案</h3>
      <p>先用右侧表单创建第一个学生。</p>
    </div>
  );
}

function SearchEmpty() {
  return (
    <div className="empty-state">
      <p>没有匹配的学生</p>
    </div>
  );
}

function StudentList({ students, selectedStudentId, onSelect, onNavigate }: { students: StudentData[]; selectedStudentId: string | null; onSelect: (student: StudentData) => void; onNavigate?: (path: string) => void }) {
  return (
    <ul className="students-list">
      {students.map((student) => (
        <li key={student.id}>
          <button
            className={student.id === selectedStudentId ? 'student-row selected' : 'student-row'}
            type="button"
            aria-current={student.id === selectedStudentId ? 'true' : undefined}
            onClick={() => onSelect(student)}
          >
            <span>
              <strong>{student.name}</strong>
              <small>{student.stageGoal ?? '暂无阶段目标'}</small>
            </span>
            <span className="student-row-meta">
              <em>{student.grade}</em>
              {onNavigate ? (
                <a
                  href={`/students/${encodeURIComponent(student.id)}`}
                  className="student-detail-link"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onNavigate(`/students/${student.id}`);
                  }}
                >
                  详情 →
                </a>
              ) : null}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function CreateStudentForm({ form, creating, message, error, onChange, onSubmit, onCancel }: { form: StudentFormState; creating: boolean; message: string | null; error: string | null; onChange: (form: StudentFormState) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onCancel: () => void }) {
  return (
    <form className="page-card students-form" onSubmit={onSubmit}>
      <h3>新增学生</h3>
      <label htmlFor="student-name">姓名</label>
      <input id="student-name" value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} />

      <label htmlFor="student-grade">年级</label>
      <input id="student-grade" value={form.grade} onChange={(event) => onChange({ ...form, grade: event.target.value })} />

      <label htmlFor="student-source">来源</label>
      <input id="student-source" value={form.source} onChange={(event) => onChange({ ...form, source: event.target.value })} />

      <label htmlFor="student-stage-goal">阶段目标</label>
      <textarea id="student-stage-goal" value={form.stageGoal} onChange={(event) => onChange({ ...form, stageGoal: event.target.value })} />

      <button className="primary-action" type="submit" disabled={creating}>{creating ? '创建中' : '创建学生'}</button>
      <button className="secondary-action" type="button" onClick={onCancel}>收起</button>
      {message ? <p className="students-message success">{message}</p> : null}
      {error ? <p className="students-message danger">{error}</p> : null}
    </form>
  );
}

function StudentProfile({ student, balance, balanceError }: { student: StudentData | null; balance: LessonBalance | null; balanceError: string | null }) {
  if (!student) {
    return (
      <article className="page-card students-profile muted-profile">
        <h3>学生档案</h3>
        <p>点击左侧学生，查看基础档案信息。</p>
      </article>
    );
  }

  return (
    <article className="page-card students-profile">
      <h3>学生档案</h3>
      <dl>
        <div>
          <dt>姓名</dt>
          <dd>{student.name}</dd>
        </div>
        <div>
          <dt>年级</dt>
          <dd>{student.grade}</dd>
        </div>
        <div>
          <dt>来源</dt>
          <dd>{student.source ?? '未记录'}</dd>
        </div>
        <div>
          <dt>当前状态</dt>
          <dd><span className={`status-badge status-badge--${student.currentStatus}`}>{studentStatusLabel(student.currentStatus)}</span></dd>
        </div>
        <div>
          <dt>阶段目标</dt>
          <dd>{student.stageGoal ?? '未记录'}</dd>
        </div>
      </dl>
      <BalanceSummary balance={balance} error={balanceError} />
    </article>
  );
}

function BalanceSummary({ balance, error }: { balance: LessonBalance | null; error: string | null }) {
  if (error) return <p className="students-message danger">余额加载失败：{error}</p>;
  if (!balance) return <p className="muted">正在加载课时余额</p>;
  return (
    <div className="student-balance-grid" aria-label="课时余额">
      <BalanceMetric label="购买课时" value={balance.purchased} />
      <BalanceMetric label="已消耗" value={balance.attended} />
      <BalanceMetric label="剩余课时" value={balance.remaining} />
    </div>
  );
}

function BalanceMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="student-balance-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function normalizeForm(form: StudentFormState) {
  return {
    name: form.name.trim(),
    grade: form.grade.trim(),
    source: form.source.trim() || undefined,
    stageGoal: form.stageGoal.trim() || undefined,
  };
}

function keepSelectedStudent(current: StudentData | null, nextStudents: StudentData[]): StudentData | null {
  if (!current) return null;
  return nextStudents.find((student) => student.id === current.id) ?? null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
