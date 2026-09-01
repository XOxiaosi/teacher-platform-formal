import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ConfirmationTurnDto, ErrorTurnDto, ToolTurnDto } from '../../api/conversations';
import { AgentErrorCard } from './AgentErrorCard';
import { TurnList } from './TurnList';

function confirmationTurn(overrides: Partial<ConfirmationTurnDto> = {}): ConfirmationTurnDto {
  return {
    id: 'pending-1',
    conversationId: 'conversation-1',
    kind: 'confirmation',
    createdAt: '2030-01-01T10:00:00.000Z',
    actionId: 'pending-1',
    actionName: 'students.updateStatus',
    target: { type: 'Student', id: 'student-1' },
    beforeSummary: '学生当前状态：active',
    afterSummary: '学生将更新为 paused',
    parameterSummary: { studentId: 'student-1', status: 'paused' },
    status: 'pending',
    expiresAt: '2030-01-01T10:10:00.000Z',
    actionToken: 'secret-action-token',
    error: null,
    ...overrides,
  };
}

function toolTurn(overrides: Partial<ToolTurnDto> = {}): ToolTurnDto {
  return {
    id: 'tool-1',
    conversationId: 'conversation-1',
    kind: 'tool',
    createdAt: '2026-07-23T10:00:00.000Z',
    toolCallId: 'call-1',
    toolName: 'students.get',
    displayName: '查询学生详情',
    sideEffect: 'read',
    status: 'success',
    inputSummary: { studentId: 'student-1', verbose: true },
    resultSummary: '已找到学生张三',
    references: [],
    error: null,
    ...overrides,
  };
}

function errorTurn(overrides: Partial<ErrorTurnDto> = {}): ErrorTurnDto {
  return {
    id: 'error-1',
    conversationId: 'conversation-1',
    kind: 'error',
    createdAt: '2026-07-23T10:00:00.000Z',
    executionId: 'execution-1',
    stage: 'model',
    error: { code: 'INTERNAL_ERROR', message: '模型响应超时' },
    retryable: true,
    retryAction: 'retry-model',
    completedToolCallIds: [],
    ...overrides,
  };
}

describe('TurnList', () => {
  it('Tool 卡展示服务端投影的动作、风险、状态、输入和结果', () => {
    render(<TurnList turns={[toolTurn()]} />);

    const card = screen.getByRole('article', { name: '工具：查询学生详情' });
    expect(card).toHaveTextContent('查询学生详情');
    expect(card).toHaveTextContent('只读');
    expect(card).toHaveTextContent('成功');
    expect(card).toHaveTextContent('studentId');
    expect(card).toHaveTextContent('student-1');
    expect(card).toHaveTextContent('已找到学生张三');
  });

  it('有presentation的Assistant使用结构化renderer，缺失时保留旧content降级', () => {
    render(<TurnList turns={[
      {
        id: 'assistant-structured',
        conversationId: 'conversation-1',
        kind: 'assistant',
        content: '兼容文本不应重复显示',
        presentation: {
          schemaVersion: 1,
          title: '结构化结果',
          summary: '这是结构化摘要',
          sections: [],
          references: [],
          actions: [],
        },
        references: [],
        createdAt: '2026-07-23T10:00:00.000Z',
      },
      {
        id: 'assistant-legacy',
        conversationId: 'conversation-1',
        kind: 'assistant',
        content: '历史纯文本回复',
        references: [],
        createdAt: '2026-07-23T10:01:00.000Z',
      },
    ]} />);

    expect(screen.getByRole('heading', { name: '结构化结果' })).toBeInTheDocument();
    expect(screen.getByText('这是结构化摘要')).toBeInTheDocument();
    expect(screen.queryByText('兼容文本不应重复显示')).not.toBeInTheDocument();
    expect(screen.getByText('历史纯文本回复')).toBeInTheDocument();
  });

  it('Assistant 与 Tool 对象引用使用服务端 route 跳转，并提供跳到最新消息入口', () => {
    render(<TurnList turns={[
      {
        id: 'assistant-1',
        conversationId: 'conversation-1',
        kind: 'assistant',
        content: '已找到张三',
        references: [{ type: 'Student', id: 'student-1', label: '张三', route: '/students/student-1' }],
        createdAt: '2026-07-23T10:00:00.000Z',
      },
      toolTurn({
        references: [{ type: 'Schedule', id: 'schedule-1', label: '今晚课程', route: '/schedules?focus=schedule-1' }],
      }),
    ]} />);

    expect(screen.getByRole('link', { name: '张三' })).toHaveAttribute('href', '/students/student-1');
    expect(screen.getByRole('link', { name: '今晚课程' })).toHaveAttribute('href', '/schedules?focus=schedule-1');
    expect(screen.getByRole('link', { name: '跳到最新消息' })).toHaveAttribute('href', '#latest-turn');
    expect(document.getElementById('latest-turn')).toBeInTheDocument();
  });

  it('pending Confirmation 卡展示核对信息并触发确认/取消，不显示 token', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<TurnList
      turns={[confirmationTurn()]}
      onConfirmAction={onConfirm}
      onCancelAction={onCancel}
    />);

    const card = screen.getByRole('article', { name: '待确认操作：更新学生状态' });
    expect(card).toHaveTextContent('students.updateStatus');
    expect(card).toHaveTextContent('学生当前状态：active');
    expect(card).toHaveTextContent('学生将更新为 paused');
    expect(card).toHaveTextContent('Student · student-1');
    expect(card).toHaveTextContent('status');
    expect(card).toHaveTextContent('paused');
    expect(card).not.toHaveTextContent('secret-action-token');

    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));
    fireEvent.click(screen.getByRole('button', { name: '取消操作' }));
    expect(onConfirm).toHaveBeenCalledWith('pending-1', 'secret-action-token');
    expect(onCancel).toHaveBeenCalledWith('pending-1');
  });

  it.each(['running', 'consumed', 'cancelled', 'expired'] as const)('%s Confirmation 无执行按钮', (status) => {
    render(<TurnList turns={[confirmationTurn({ status, actionToken: null })]} />);

    expect(screen.queryByRole('button', { name: '确认执行' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '取消操作' })).not.toBeInTheDocument();
    expect(screen.getByRole('article', { name: '待确认操作：更新学生状态' })).toHaveTextContent(
      status === 'running' ? '执行中' : status === 'consumed' ? '已完成' : status === 'cancelled' ? '已取消' : '已过期',
    );
  });

  it('Confirmation 请求中禁用双按钮并显示卡片错误；归档时只读', () => {
    const { rerender } = render(<TurnList
      turns={[confirmationTurn()]}
      confirmationBusyActionId="pending-1"
      confirmationOperation="confirm"
      confirmationErrors={{ 'pending-1': '确认请求失败' }}
    />);

    expect(screen.getByRole('button', { name: '正在确认…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消操作' })).toBeDisabled();
    expect(screen.getByText('确认请求失败')).toBeInTheDocument();

    rerender(<TurnList turns={[confirmationTurn()]} readonly />);
    expect(screen.getByRole('button', { name: '确认执行' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消操作' })).toBeDisabled();
  });

  it('Error turn 展示结构化失败并仅在服务端允许时触发安全回放', () => {
    const onRetry = vi.fn();
    render(<TurnList turns={[errorTurn()]} onRetryExecution={onRetry} />);

    expect(screen.getByRole('alert')).toHaveTextContent('模型响应超时');
    fireEvent.click(screen.getByRole('button', { name: '安全重试' }));
    expect(onRetry).toHaveBeenCalledWith('execution-1');
  });

  it('partial/不可重试错误展示已完成数量且不提供回放按钮', () => {
    render(<TurnList turns={[errorTurn({
      retryable: false,
      retryAction: 'none',
      completedToolCallIds: ['call-1'],
    })]} />);

    expect(screen.getByRole('alert')).toHaveTextContent('已完成 1 个工具调用');
    expect(screen.queryByRole('button', { name: '安全重试' })).not.toBeInTheDocument();
  });

  it('失败 Tool 卡展示错误且不伪装成功结果', () => {
    render(<TurnList turns={[toolTurn({
      status: 'failed',
      resultSummary: null,
      error: { code: 'INTERNAL_ERROR', message: '学生服务暂不可用' },
    })]} />);

    expect(screen.getByRole('article', { name: '工具：查询学生详情' })).toHaveTextContent('失败');
    expect(screen.getByText('学生服务暂不可用')).toBeInTheDocument();
  });
});

describe('AgentErrorCard', () => {
  it('说明不会自动重试', () => {
    render(<AgentErrorCard message="模型暂不可用" />);

    expect(screen.getByRole('alert')).toHaveTextContent('模型暂不可用');
    expect(screen.getByRole('alert')).toHaveTextContent('系统不会自动重复执行');
  });
});
