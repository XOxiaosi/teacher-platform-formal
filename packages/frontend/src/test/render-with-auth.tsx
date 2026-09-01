import { render, type RenderResult } from '@testing-library/react';
import { vi } from 'vitest';
import type { ReactElement } from 'react';
import { TeacherProvider } from '../app/teacher-context';
import * as authApi from '../api/auth';
import type { MeData } from '../api/auth';

export interface RenderWithAuthOptions {
  meValue?: MeData | null;
  /** 未提供时默认匿名（me → null）。 */
  status?: 'authed' | 'anon';
}

export const demoMe: MeData = { id: 'demo-teacher', email: 'demo@example.com', displayName: '演示老师' };

/** 用真实 TeacherProvider 包裹渲染，me() 由 mock 控制，自动落到目标 auth 状态。 */
export function renderWithAuth(
  ui: ReactElement,
  options: RenderWithAuthOptions = {},
): RenderResult {
  const meValue = options.status === 'anon' || options.meValue === undefined ? null : options.meValue;
  vi.mocked(authApi.me).mockResolvedValue(meValue);
  return render(<TeacherProvider>{ui}</TeacherProvider>);
}

export function mockMe(value: MeData | null): void {
  vi.mocked(authApi.me).mockResolvedValue(value);
}

export function mockLogout(): ReturnType<typeof vi.fn> {
  const mock = vi.mocked(authApi.logout).mockResolvedValue(undefined);
  return mock;
}
