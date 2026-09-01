import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ConfirmationTurnDto } from '../../api/conversations';
import { ConfirmationTurnCard } from './ConfirmationTurnCard';

/**
 * P2 实现5（t50）：ConfirmationTurnCard 独立组件测试。
 * 此前只有 AgentPage 集成级覆盖，缺组件级直接断言（状态标签/disabled 逻辑/回调参数）。
 */

function pendingTurn(overrides: Partial<ConfirmationTurnDto> = {}): ConfirmationTurnDto {
  return {
    id: 'turn-confirm-1',
    conversationId: 'conv-1',
    kind: 'confirmation',
    createdAt: '2030-07-24T02:00:00.000Z',
    actionName: 'scheduling.complete',
    actionId: 'action-1',
    actionToken: 'token-abc',
    target: { type: 'Schedule', id: 'schedule/1' },
    beforeSummary: '日程待完成',
    afterSummary: '标记日程为已完成',
    parameterSummary: { scheduleId: 'schedule/1' },
    status: 'pending',
    expiresAt: '2030-07-24T03:00:00.000Z',
    error: null,
    ...overrides,
  };
}

describe('ConfirmationTurnCard', () => {
  it('渲染动作名/状态/对象/前后摘要/参数/有效期；pending 显示确认与取消按钮', () => {
    render(<ConfirmationTurnCard turn={pendingTurn()} />);

    expect(screen.getByRole('article', { name: '待确认操作：完成日程' })).toBeInTheDocument();
    expect(screen.getByText('等待确认')).toBeInTheDocument();
    expect(screen.getByText('Schedule · schedule/1')).toBeInTheDocument();
    expect(screen.getByText('日程待完成')).toBeInTheDocument();
    expect(screen.getByText('标记日程为已完成')).toBeInTheDocument();
    expect(screen.getByText('scheduleId')).toBeInTheDocument();
    expect(screen.getByText(/服务端有效期至 2030-07-24/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认执行' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消操作' })).toBeInTheDocument();
  });

  it('确认回调携带 actionId + actionToken；取消回调携带 actionId', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmationTurnCard
        turn={pendingTurn()}
        onConfirmAction={onConfirm}
        onCancelAction={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));
    expect(onConfirm).toHaveBeenCalledWith('action-1', 'token-abc');

    fireEvent.click(screen.getByRole('button', { name: '取消操作' }));
    expect(onCancel).toHaveBeenCalledWith('action-1');
  });

  it('无 actionToken → 确认与取消按钮均 disabled', () => {
    render(<ConfirmationTurnCard turn={pendingTurn({ actionToken: null })} />);
    expect(screen.getByRole('button', { name: '确认执行' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消操作' })).toBeDisabled();
  });

  it('未提供确认回调 → 确认按钮 disabled，取消可用', () => {
    render(
      <ConfirmationTurnCard
        turn={pendingTurn({ actionToken: 'token-1' })}
        onCancelAction={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: '确认执行' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消操作' })).toBeEnabled();
  });

  it('未提供取消回调 → 取消按钮 disabled，确认可用', () => {
    render(
      <ConfirmationTurnCard
        turn={pendingTurn({ actionToken: 'token-1' })}
        onConfirmAction={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: '确认执行' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '取消操作' })).toBeDisabled();
  });

  it('busy + operation 显示正在确认/正在取消并禁用两个按钮', () => {
    render(
      <ConfirmationTurnCard
        turn={pendingTurn()}
        busy
        operation="confirm"
        onConfirmAction={() => undefined}
        onCancelAction={() => undefined}
      />,
    );

    expect(screen.getByRole('button', { name: '正在确认…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消操作' })).toBeDisabled();
  });

  it.each([
    ['consumed', '已完成'],
    ['cancelled', '已取消'],
    ['expired', '已过期'],
    ['running', '执行中'],
  ] as const)('非 pending 状态 %s：状态标签 %s，不渲染操作按钮', (status, label) => {
    render(<ConfirmationTurnCard turn={pendingTurn({ status })} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认执行' })).not.toBeInTheDocument();
  });

  it('readonly 模式禁用操作按钮', () => {
    render(
      <ConfirmationTurnCard
        turn={pendingTurn()}
        readonly
        onConfirmAction={() => undefined}
        onCancelAction={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: '确认执行' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消操作' })).toBeDisabled();
  });

  it('error prop 展示 role=alert', () => {
    render(
      <ConfirmationTurnCard
        turn={pendingTurn()}
        error="确认失败，请重试"
        onConfirmAction={() => undefined}
        onCancelAction={() => undefined}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('确认失败，请重试');
  });

  it('turn.error 展示 role=alert（服务端错误）', () => {
    render(
      <ConfirmationTurnCard
        turn={pendingTurn({ error: { code: 'INTERNAL_ERROR', message: '服务端错误' } })}
        onConfirmAction={() => undefined}
        onCancelAction={() => undefined}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('服务端错误');
  });

  it('未知 actionName 回退显示原始名称；无参数摘要时隐藏参数区', () => {
    render(<ConfirmationTurnCard turn={pendingTurn({ actionName: 'custom.action', parameterSummary: {} })} />);
    expect(screen.getByRole('article', { name: '待确认操作：custom.action' })).toBeInTheDocument();
    expect(screen.queryByText('parameterSummary')).not.toBeInTheDocument();
  });
});
