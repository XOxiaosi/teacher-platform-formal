import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const runtimeFiles = readdirSync(directory)
  .filter((name) => /\.(ts|tsx)$/.test(name) && !name.includes('.test.'));
const runtime = runtimeFiles.map((name) => readFileSync(join(directory, name), 'utf8')).join('\n');

describe('独立免登录原型的运行边界', () => {
  it('局部详情按钮定位不能污染模型和微信配置页面', () => {
    const localStyles = ['students-edit.css', 'settings-configuration.css']
      .map((name) => readFileSync(join(directory, name), 'utf8')).join('\n');
    expect(localStyles).not.toMatch(/(?:^|\n)\.text-button\s*\{/);
    expect(localStyles).toContain('.choice-card input { width: 18px; height: 18px; min-height: 0;');
    const scheduleStyle = readFileSync(join(directory, 'schedule.css'), 'utf8');
    expect(scheduleStyle).toContain('.week-scroll .week-item.compact');
    expect(scheduleStyle).toContain('.short-schedule-list');
  });
  it('全部样式变量都有定义，分工样式不能丢失颜色和字体', () => {
    const styles = readFileSync(join(directory, '../design-system/theme.css'), 'utf8') + readdirSync(directory).filter((name) => name.endsWith('.css'))
      .map((name) => readFileSync(join(directory, name), 'utf8')).join('\n');
    const defined = new Set(Array.from(styles.matchAll(/(--[\w-]+)\s*:/g), (match) => match[1]));
    const used = new Set(Array.from(styles.matchAll(/var\((--[\w-]+)/g), (match) => match[1]));
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
  });
  it('使用独立 HTML 和 React 入口，不接入正式应用', () => {
    const html = readFileSync(join(directory, '../../preview.html'), 'utf8');
    const main = readFileSync(join(directory, 'main.tsx'), 'utf8');
    expect(html).toContain('/src/preview/main.tsx');
    expect(main).toContain('./PreviewApp');
    expect(main).not.toContain('../app/');
    expect(runtime).not.toMatch(/(?:from\s+|import\s*)['"][^'"]*(?:\/api\/|\/teacher-context|@teacher-platform\/)/);
  });

  it('没有业务网络请求、持久存储或外部资源地址', () => {
    expect(runtime).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/);
    expect(runtime).not.toMatch(/\b(?:sendBeacon|localStorage|sessionStorage|indexedDB)\b/);
    expect(runtime).not.toMatch(/https?:\/\//);
    // Vite 的开发热更新不属于原型业务；构建后的入口无需后端和 U 盘。
  });

  it('正式前端表达移除开发提示，但不伪造外部服务或加入敏感输入', () => {
    expect(runtime).not.toMatch(/type=["'](?:password|file)["']/);
    expect(runtime).not.toMatch(/(?:setApiKey|apiKey\s*:|accessToken\s*:)/);
    expect(runtime).not.toMatch(/测试版|示例|演示|刷新还原|请勿输入真实资料|伪造成功/);
    expect(runtime).toContain('模型未配置');
    expect(runtime).toContain('微信未连接');
  });

  it('排期模型不包含课程标题、学科、目标或授课内容', () => {
    const data = readFileSync(join(directory, 'data.ts'), 'utf8');
    const model = data.match(/export type Schedule\s*=\s*\{([\s\S]*?)\};/)?.[1];
    expect(model).toBeDefined();
    expect(model).toMatch(/location/);
    expect(model).toMatch(/participants/);
    expect(model).toMatch(/format/);
    expect(model).toMatch(/note/);
    expect(model).not.toMatch(/\b(?:title|subject|content|goal|objective|grade)\b/);
  });
});
