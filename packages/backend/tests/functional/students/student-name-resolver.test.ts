import { describe, expect, it } from 'vitest';
import {
  normalizeStudentName,
  resolveStudentByName,
} from '../../../src/features/students/index.js';

// t56（渠道线）：学生身份自动解析——姓名匹配（精确 → 前缀 → 包含；无模糊音/拼音，范围外）。

const STUDENTS = [
  { id: 's-zhangsan', name: '张三' },
  { id: 's-lisi', name: '李四' },
  { id: 's-zhang-sanfeng', name: '张三丰' },
  { id: 's-wang', name: '王五' },
  { id: 's-abc', name: 'ABC 同学' },
];

describe('normalizeStudentName', () => {
  it('去空白（含全角空格）', () => {
    expect(normalizeStudentName(' 张 三 ')).toBe('张三');
    expect(normalizeStudentName('张\u3000三')).toBe('张三');
    expect(normalizeStudentName('\t张三\n')).toBe('张三');
  });

  it('全角字母数字转半角 + 小写', () => {
    expect(normalizeStudentName('ＡＢＣ')).toBe('abc');
    expect(normalizeStudentName('Ｚｚ１２３')).toBe('zz123');
    expect(normalizeStudentName('ABC')).toBe('abc');
  });

  it('中文保持不变', () => {
    expect(normalizeStudentName('张三丰')).toBe('张三丰');
  });
});

describe('resolveStudentByName', () => {
  it('精确匹配优先（唯一）→ exact', () => {
    const result = resolveStudentByName(STUDENTS, '张三');
    expect(result.kind).toBe('exact');
    if (result.kind === 'exact') expect(result.student.id).toBe('s-zhangsan');
  });

  it('忽略空白/全角空格后精确匹配', () => {
    const result = resolveStudentByName(STUDENTS, '张 三');
    expect(result.kind).toBe('exact');
    if (result.kind === 'exact') expect(result.student.id).toBe('s-zhangsan');

    const fullWidthSpace = resolveStudentByName(STUDENTS, '张\u3000三');
    expect(fullWidthSpace.kind).toBe('exact');
    if (fullWidthSpace.kind === 'exact') expect(fullWidthSpace.student.id).toBe('s-zhangsan');
  });

  it('全角字母转半角：精确命中或前缀命中', () => {
    // 'ＡＢＣ' → 'abc'：学生名 'ABC 同学' 归一化 'abc同学'，前缀命中 → candidate
    const prefix = resolveStudentByName(STUDENTS, 'ＡＢＣ');
    expect(prefix.kind).toBe('candidate');
    if (prefix.kind === 'candidate') expect(prefix.student.id).toBe('s-abc');

    // 学生名本身为 'abc' 时全角输入精确命中 → exact
    const exact = resolveStudentByName([{ id: 's-pure', name: 'abc' }], 'ＡＢＣ');
    expect(exact.kind).toBe('exact');
    if (exact.kind === 'exact') expect(exact.student.id).toBe('s-pure');
  });

  it('前缀唯一 → candidate', () => {
    const result = resolveStudentByName(STUDENTS, '李');
    expect(result.kind).toBe('candidate');
    if (result.kind === 'candidate') expect(result.student.id).toBe('s-lisi');
  });

  it('前缀多候选 → ambiguous（候选列表）', () => {
    const result = resolveStudentByName(STUDENTS, '张');
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates.map((s) => s.id).sort()).toEqual(['s-zhang-sanfeng', 's-zhangsan']);
    }
  });

  it('包含匹配唯一 → candidate', () => {
    const result = resolveStudentByName(STUDENTS, '五');
    expect(result.kind).toBe('candidate');
    if (result.kind === 'candidate') expect(result.student.id).toBe('s-wang');
  });

  it('包含匹配多候选 → ambiguous', () => {
    // '三' 同时包含于 张三 / 张三丰
    const result = resolveStudentByName(STUDENTS, '三');
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates.map((s) => s.id).sort()).toEqual(['s-zhang-sanfeng', 's-zhangsan']);
    }
  });

  it('候选列表受 maxCandidates 截断（避免误配）', () => {
    const many = Array.from({ length: 10 }, (_, index) => ({ id: `s-${index}`, name: `张${index}` }));
    const result = resolveStudentByName(many, '张', { maxCandidates: 3 });
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') expect(result.candidates).toHaveLength(3);
  });

  it('无匹配 → not_found', () => {
    const result = resolveStudentByName(STUDENTS, '赵六');
    expect(result.kind).toBe('not_found');
  });

  it('空/纯空白输入 → not_found', () => {
    expect(resolveStudentByName(STUDENTS, '').kind).toBe('not_found');
    expect(resolveStudentByName(STUDENTS, '   ').kind).toBe('not_found');
  });

  it('空学生列表 → not_found', () => {
    expect(resolveStudentByName([], '张三').kind).toBe('not_found');
  });
});

describe('Agent 消息场景演示用例（最小接入：listStudents → resolveStudentByName → 候选）', () => {
  // 完整 Agent 提示词增强（把候选注入 system prompt）标注为后续渠道线工作；
  // 本用例演示接入路径：老师消息「帮张三安排下节课」→ 从学生列表解析出唯一学生。
  it('消息含唯一学生名 → 解析出该学生（可用于工具参数补全）', async () => {
    // 模拟 students.list 返回当前 teacher 的学生列表
    const students = [
      { id: 's-a', name: '张三' },
      { id: 's-b', name: '李四' },
    ];
    const message = '帮张三安排下节课';
    // 演示：从消息中提取疑似学生名（渠道线后续可接实体抽取/分词），此处直接取姓名
    const suspectedName = '张三';

    const resolution = resolveStudentByName(students, suspectedName);
    expect(resolution.kind).toBe('exact');
    if (resolution.kind === 'exact') {
      // 接入点：把解析结果提供给工具调用（如 scheduling.create 的 studentId 补全）
      expect(resolution.student.id).toBe('s-a');
      expect(message).toContain(resolution.student.name);
    }
  });

  it('消息中的姓名有歧义 → 返回候选列表（提示用户确认，不自动误配）', () => {
    const students = [
      { id: 's-a', name: '张三' },
      { id: 's-b', name: '张三丰' },
    ];
    const resolution = resolveStudentByName(students, '张三');
    // 精确命中张三（exact 优先于前缀），若消息只提「张」则歧义
    const ambiguous = resolveStudentByName(students, '张');
    expect(resolution.kind).toBe('exact');
    expect(ambiguous.kind).toBe('ambiguous');
    if (ambiguous.kind === 'ambiguous') {
      expect(ambiguous.candidates.map((s) => s.id).sort()).toEqual(['s-a', 's-b']);
    }
  });
});
