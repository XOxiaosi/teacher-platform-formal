import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDemoData, type DemoData } from './data';
import type { PreviewActions } from './PreviewApp';
import { WechatFeedbackInbox } from './WechatFeedbackInbox';

function DemoInbox({ initial = createDemoData() }: { initial?: DemoData }) {
  const [data, setData] = useState(initial);
  const actions: PreviewActions = {
    data, setData, ui: {}, setUi: vi.fn(), open: vi.fn(), close: vi.fn(), toast: vi.fn(),
    complete: vi.fn(), saveSchedule: vi.fn(), cancelSchedule: vi.fn(), saveRule: vi.fn(), replaceRuleFrom: vi.fn(), setRuleEnabled: vi.fn(), addPayment: vi.fn(),
  };
  return <><WechatFeedbackInbox actions={actions} /><output data-testid="demo-state">{JSON.stringify({ balances: data.students.map((student) => student.balance), items: data.wechatFeedbacks })}</output></>;
}

function pendingBadge(count: number) {
  return screen.getByText((_, node) => node?.getAttribute('data-slot') === 'badge' && node.textContent === `${count} 项待核对`);
}

describe('微信学生反馈收件区', () => {
  it('将微信反馈与家长反馈草稿分开，并展示待核对数量与来源', () => {
    render(<DemoInbox />);
    expect(screen.getByRole('heading', { name: '微信学生反馈' })).toBeInTheDocument();
    expect(pendingBadge(2)).toBeInTheDocument();
    expect(screen.getAllByText(/来源：微信教师私聊/).length).toBeGreaterThan(0);
    expect(screen.getByText(/和“家长反馈草稿”分开处理/)).toBeInTheDocument();
  });

  it('确认仅更新演示反馈，不改课时余额且重复打开不再提供确认', () => {
    render(<DemoInbox />);
    const before = screen.getByTestId('demo-state').textContent;
    fireEvent.click(screen.getAllByRole('button', { name: '核对详情' })[0]);
    fireEvent.change(screen.getByLabelText('拟写入记录'), { target: { value: '已核对的学生情况' } });
    fireEvent.click(screen.getByRole('button', { name: '确认并标记已记录' }));
    const after = screen.getByTestId('demo-state').textContent || '';
    expect(before).toContain('"balances":[6,2,8,4]');
    expect(after).toContain('"balances":[6,2,8,4]');
    expect(after).toContain('"recordState":"演示已记录"');
    const firstRow = screen.getByText('李雨桐').closest('article');
    if (!firstRow) throw new Error('feedback row unavailable');
    expect(within(firstRow).getByText('已核对的学生情况')).toBeInTheDocument();
    expect(firstRow).not.toHaveTextContent('等待归入学习记录');
    fireEvent.click(within(firstRow).getByRole('button', { name: '查看记录详情' }));
    expect(screen.queryByRole('button', { name: '确认并标记已记录' })).not.toBeInTheDocument();
  });

  it('未知学生保持未归属，不能默认确认或按称呼自动匹配', () => {
    render(<DemoInbox />);
    const row = screen.getByText('小周（待确认）').closest('article');
    if (!row) throw new Error('unknown-student row unavailable');
    fireEvent.click(within(row).getByRole('button', { name: '核对详情' }));
    expect(screen.getByLabelText('归属学生')).toHaveValue('');
    expect(screen.getByText(/系统不会按相似称呼自动匹配/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认并标记已记录' })).toBeDisabled();
  });

  it('失效学生标识不能通过确认门槛', () => {
    const data = createDemoData();
    data.wechatFeedbacks = data.wechatFeedbacks?.map((item) => item.id === 'wx-demo-1' ? { ...item, studentId: 'student-missing' } : item);
    render(<DemoInbox initial={data} />);
    fireEvent.click(screen.getAllByRole('button', { name: '核对详情' })[0]);
    expect(screen.getByRole('button', { name: '确认并标记已记录' })).toBeDisabled();
  });

  it('失败条目只能演示重试，重试后仍待人工核对而非自动成功', () => {
    render(<DemoInbox />);
    fireEvent.click(screen.getByRole('button', { name: '查看处理说明' }));
    expect(screen.getByRole('alert')).toHaveTextContent('消息内容不完整');
    fireEvent.click(screen.getByRole('button', { name: '演示重试' }));
    const state = screen.getByTestId('demo-state').textContent || '';
    const retry = JSON.parse(state).items.find((item: { id: string }) => item.id === 'wx-demo-4');
    expect(retry).toMatchObject({ retryRequested: true, status: '待核对', recordState: '未保存' });
    expect(retry.summary).toContain('尚未形成学生记录');
  });

  it('拒绝后不再计入待核对，只有教师明确操作才可再次核对', () => {
    render(<DemoInbox />);
    fireEvent.click(screen.getAllByRole('button', { name: '核对详情' })[0]);
    fireEvent.click(screen.getByRole('button', { name: '拒绝归档' }));
    const state = JSON.parse(screen.getByTestId('demo-state').textContent || '{}');
    expect(state.items.find((item: { id: string }) => item.id === 'wx-demo-1')).toMatchObject({ status: '已拒绝', recordState: '无需保存' });
    expect(pendingBadge(1)).toBeInTheDocument();
  });

  it('正式连接没有微信 DTO 时如实说明暂无法读取，不注入合成样例', () => {
    const data = { ...createDemoData(), wechatFeedbacks: undefined };
    const actions: PreviewActions = {
      connected: true, data, setData: vi.fn(), ui: {}, setUi: vi.fn(), open: vi.fn(), close: vi.fn(), toast: vi.fn(),
      complete: vi.fn(), saveSchedule: vi.fn(), cancelSchedule: vi.fn(), saveRule: vi.fn(), replaceRuleFrom: vi.fn(), setRuleEnabled: vi.fn(), addPayment: vi.fn(),
    };
    render(<WechatFeedbackInbox actions={actions} />);
    expect(screen.getByText(/暂无法读取或核对消息/)).toBeInTheDocument();
    expect(screen.queryByText(/项待核对/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看微信连接' })).toHaveAttribute('href', '#/settings/wechat');
    expect(screen.getByRole('link', { name: '查看已有待核对材料' })).toHaveAttribute('href', '#/captures');
  });
});
