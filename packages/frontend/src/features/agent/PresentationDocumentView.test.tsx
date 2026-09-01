import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PresentationDocument } from '@teacher-platform/contracts';
import { PresentationDocumentView } from './PresentationDocumentView';

const presentationDocument: PresentationDocument = {
  schemaVersion: 1,
  title: '学生与课程',
  summary: '已找到张三，并确认下一次课程。',
  sections: [
    { id: 'text-1', kind: 'text', heading: '说明', text: '<script>alert(1)</script>' },
    {
      id: 'facts-1',
      kind: 'facts',
      heading: '学生信息',
      items: [
        { label: '姓名', value: '张三' },
        { label: '年级', value: '高三' },
      ],
    },
    {
      id: 'list-1',
      kind: 'list',
      heading: '近期安排',
      items: [{
        id: 'schedule-item-1',
        label: '周六课程',
        detail: '2030-07-20T08:00:00.000Z',
        referenceId: 'Schedule:schedule/1',
      }],
    },
  ],
  references: [
    { id: 'Student:student/1', type: 'Student', objectId: 'student/1', label: '张三' },
    { id: 'Schedule:schedule/1', type: 'Schedule', objectId: 'schedule/1', label: '周六课程' },
  ],
  actions: [{
    id: 'open-schedule',
    kind: 'open-reference',
    label: '查看课程',
    referenceId: 'Schedule:schedule/1',
  }],
};

describe('PresentationDocumentView', () => {
  it('语义化渲染标题、summary和三种section，模型文本按纯文本显示', () => {
    render(<PresentationDocumentView document={presentationDocument} />);

    expect(screen.getByRole('article', { name: '学生与课程' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '学生与课程' })).toBeInTheDocument();
    expect(screen.getByText('已找到张三，并确认下一次课程。')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '说明' })).toBeInTheDocument();
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(document.body.querySelector('script')).toBeNull();
    expect(screen.getByText('姓名')).toBeInTheDocument();
    expect(screen.getByText('高三')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: '近期安排' })).toBeInTheDocument();
  });

  it('引用与动作只使用受控编码route，并通过onNavigate内部导航', () => {
    const onNavigate = vi.fn();
    render(<PresentationDocumentView document={presentationDocument} onNavigate={onNavigate} />);

    expect(screen.getByRole('link', { name: '张三' })).toHaveAttribute('href', '/students/student%2F1');
    expect(screen.getByRole('link', { name: '周六课程' })).toHaveAttribute(
      'href',
      '/schedules?focus=schedule%2F1',
    );
    const action = screen.getByRole('link', { name: '查看课程' });
    expect(action).toHaveAttribute('href', '/schedules?focus=schedule%2F1');
    fireEvent.click(action);
    expect(onNavigate).toHaveBeenCalledWith('/schedules?focus=schedule%2F1');
  });

  it('悬空action、未知类型和缺studentId的Lesson/Payment不生成链接', () => {
    const unsafe = {
      ...presentationDocument,
      references: [
        { id: 'Lesson:lesson-1', type: 'Lesson' as const, objectId: 'lesson-1', label: '课次' },
        { id: 'Payment:payment-1', type: 'Payment' as const, objectId: 'payment-1', label: '缴费' },
      ],
      actions: [{
        id: 'missing',
        kind: 'open-reference' as const,
        label: '悬空动作',
        referenceId: 'missing-reference',
      }],
    };

    render(<PresentationDocumentView document={unsafe} />);

    expect(screen.queryByRole('link', { name: '课次' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '缴费' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '悬空动作' })).not.toBeInTheDocument();
    expect(screen.getByText('课次')).toBeInTheDocument();
    expect(screen.getByText('缴费')).toBeInTheDocument();
  });
});
