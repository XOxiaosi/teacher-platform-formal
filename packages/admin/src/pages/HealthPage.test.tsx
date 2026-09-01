import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as adminActionsApi from '../api/adminActions';
import { HealthPage } from './HealthPage';

vi.mock('../api/adminActions');

beforeEach(() => {
  vi.mocked(adminActionsApi.getInteractions).mockReset().mockResolvedValue({
    total: 10,
    byStatus: { succeeded: 8, failed: 2 },
    avgDurationMs: 500,
    maxDurationMs: 900,
    errorRate: 0.2,
    lastInteractionAtTs: '2026-08-31T04:00:00.000Z',
  });
  vi.mocked(adminActionsApi.getHealth).mockReset().mockResolvedValue({
    ready: true,
    dbHealth: { ok: 2, missing: 0, migrationBehind: 1, unreachable: 0 },
    backup: { lastRunId: 'run-1', lastRunAtTs: '2026-08-31T02:00:00.000Z', databases: 3, success: true },
    migration: { applied: 12, expected: 12 },
    metrics: { requests5xx: 0, p95DurationMs: 320 },
  });
});

describe('HealthPage', () => {
  it('渲染交互统计卡片与系统健康', async () => {
    render(<HealthPage />);

    expect(await screen.findByText('Agent 交互统计')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument(); // 执行总数
    expect(screen.getByText('500ms')).toBeInTheDocument(); // 平均耗时
    expect(screen.getByText('900ms')).toBeInTheDocument(); // 最大耗时
    expect(screen.getByText('20.0%')).toBeInTheDocument(); // 错误率
    expect(screen.getByText('succeeded')).toBeInTheDocument();
    expect(screen.getByText('系统健康')).toBeInTheDocument();
    expect(screen.getByText('共享库可达（ready）')).toBeInTheDocument();
    expect(screen.getAllByText('2').length).toBe(2); // 巡检正常 2 + failed 分布 2
    expect(screen.getByText('12 / 12')).toBeInTheDocument(); // 迁移版本
  });

  it('健康不可达展示 ready 失败状态与原因', async () => {
    vi.mocked(adminActionsApi.getHealth).mockResolvedValue({
      ready: false,
      dbHealth: { ok: 0, missing: 0, migrationBehind: 0, unreachable: 2 },
      backup: { lastRunId: null, lastRunAtTs: null, databases: 0, success: null },
      migration: { applied: 0, expected: 12 },
      metrics: { requests5xx: 0, p95DurationMs: null },
      message: '连接被拒绝',
    });
    render(<HealthPage />);

    expect(await screen.findByText(/共享库不可达：连接被拒绝/)).toBeInTheDocument();
  });

  it('加载失败展示错误态', async () => {
    vi.mocked(adminActionsApi.getHealth).mockRejectedValue(new Error('network down'));
    render(<HealthPage />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('看板加载失败：network down');
  });
});
