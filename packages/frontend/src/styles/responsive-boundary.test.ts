/// <reference types="node" />

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * P2 移动端适配边界（D50 §5.2）。
 * 与 a4-agenda-ui-boundary.test.ts 同风格：源码字符串断言，
 * 保证移动端断点/safe-area/卡片化/日程降级规则不被无意删改。
 */
const frontendRoot = resolve(process.cwd());

function source(relativePath: string): string {
  const path = resolve(frontendRoot, relativePath);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

describe('P2 移动端适配边界', () => {
  it('index.html 设置 viewport-fit=cover（safe-area 前提）', () => {
    const html = source('index.html');
    expect(html).toContain('viewport-fit=cover');
  });

  it('globals.css 提供 ≤768px 断点：解除桌面 min-width、侧边栏顶栏化、44px 触控目标、safe-area', () => {
    const css = source('src/styles/globals.css');
    expect(css).toContain('@media (max-width: 768px)');
    expect(css).toContain('min-width: 0'); // 解除 body 1280px 下限
    expect(css).toContain('grid-template-columns: 1fr'); // app-shell 单列
    expect(css).toContain('flex-direction: row'); // 侧边栏 → 顶栏
    expect(css).toContain('min-height: 44px'); // 触控目标
    expect(css).toContain('env(safe-area-inset-bottom');
    expect(css).toContain('env(safe-area-inset-top');
    expect(css).toContain('.desktop-width-warning');
  });

  it('globals.css 移动端隐藏“请使用桌面窗口”提示', () => {
    const css = source('src/styles/globals.css');
    const mobileBlock = css.slice(css.indexOf('@media (max-width: 768px)'));
    const warningHidden = mobileBlock.slice(mobileBlock.indexOf('.desktop-width-warning'));
    expect(warningHidden).toContain('display: none');
  });

  it('缴费表格 → 卡片：payments.css 使用 attr(data-label)，PaymentsPage td 带 data-label', () => {
    const css = source('src/features/payments/payments.css');
    const page = source('src/features/payments/PaymentsPage.tsx');
    expect(css).toContain('@media (max-width: 768px)');
    expect(css).toContain('attr(data-label)');
    expect(css).toContain('.payments-table thead');
    expect(page.match(/data-label=/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it('日程周视图降级：schedules.css 默认隐藏 week-mobile-agenda，移动端隐藏周网格并显示纵向列表', () => {
    const css = source('src/features/schedules/schedules.css');
    expect(css).toContain('.week-mobile-agenda');
    expect(css).toContain('display: none');
    const mobileBlock = css.slice(css.indexOf('@media (max-width: 768px)'));
    expect(mobileBlock).toContain('.week-days');
    expect(mobileBlock).toContain('display: none');
    expect(mobileBlock).toContain('.week-mobile-agenda');
  });

  it('WeekScheduleView 复用 AgendaItemView 渲染移动纵向列表', () => {
    const view = source('src/features/schedules/WeekScheduleView.tsx');
    expect(view).toContain('week-mobile-agenda');
    expect(view).toContain('AgendaItemView');
  });

  it('学生列表移动端堆叠卡片 + 触控目标', () => {
    const css = source('src/features/students/students.css');
    const mobileBlock = css.slice(css.indexOf('@media (max-width: 768px)'));
    expect(mobileBlock).toContain('flex-direction: column');
    expect(mobileBlock).toContain('min-height: 44px');
  });

  it('auth 页 safe-area 适配（卡片已 min(420px,100%) 响应式）', () => {
    const css = source('src/features/auth/auth.css');
    const mobileBlock = css.slice(css.indexOf('@media (max-width: 768px)'));
    expect(mobileBlock).toContain('env(safe-area-inset-');
  });
});
