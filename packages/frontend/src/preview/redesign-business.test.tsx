import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PreviewApp } from './PreviewApp';

function route(path: string) {
  window.history.replaceState(null, '', `#/${path}`);
}

afterEach(() => window.history.replaceState(null, '', '/'));

describe('教师业务页重设计组件边界', () => {
  it.each([
    ['today', 'button', 'card'],
    ['students', 'input', 'card'],
    ['schedules', 'button', 'card'],
    ['finance', 'button', 'card'],
    ['feedback', 'button', 'card'],
    ['settings', 'button', 'card'],
  ])('%s 页面使用 shadcn 的 %s 与 %s', (path, firstSlot, secondSlot) => {
    route(path);
    const { container } = render(<PreviewApp />);
    const page = container.querySelector('main')!;
    expect(page.querySelector(`[data-slot="${firstSlot}"]`)).toBeInTheDocument();
    expect(page.querySelector(`[data-slot="${secondSlot}"]`)).toBeInTheDocument();
  });
});
