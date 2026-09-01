import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTeacherTimeContext } from '../dist/index.js';

test('用固定业务时区格式化可信 instant，不依赖设备本地时区', () => {
  const content = formatTeacherTimeContext({
    now: new Date('2026-07-25T07:48:00.000Z'),
    timeZone: 'Asia/Shanghai',
  });

  assert.match(content, /2026-07-25/u);
  assert.match(content, /15:48:00/u);
  assert.match(content, /星期六/u);
  assert.match(content, /Asia\/Shanghai/u);
  assert.match(content, /createdAt/u);
  assert.match(content, /时区/u);
});

test('跨 UTC 日期边界时仍以教师业务日期解释相对日期', () => {
  const content = formatTeacherTimeContext({
    now: new Date('2026-07-24T16:30:00.000Z'),
    timeZone: 'Asia/Shanghai',
  });

  assert.match(content, /可信 instant（UTC）：2026-07-24T16:30:00\.000Z/u);
  assert.match(content, /当前日期：2026-07-25/u);
  assert.match(content, /当前时间：00:30:00/u);
  assert.match(content, /相对日期必须以本段可信时间为基准/u);
});
