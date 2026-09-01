import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = resolve(process.cwd(), 'src');

function source(relativePath: string): ts.SourceFile {
  const path = resolve(SOURCE_ROOT, relativePath);
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function callsNamed(file: ts.SourceFile, name: string): ts.CallExpression[] {
  const matches: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return matches;
}

function importedNames(file: ts.SourceFile): string[] {
  return file.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings
      || !ts.isNamedImports(statement.importClause.namedBindings)) return [];
    return statement.importClause.namedBindings.elements.map((element) => element.name.text);
  });
}

describe('ParentFeedback trusted-time architecture boundary', () => {
  it('feedback feature owner 装配 DatabaseTrustedClock 缺省值且不生成 AppClock', () => {
    const file = source('features/feedback/feedback-service.ts');
    expect(importedNames(file)).toContain('createDatabaseTrustedClock');
    expect(callsNamed(file, 'createDatabaseTrustedClock')).toHaveLength(1);

    const noArgDateCalls: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === 'Date' && (node.arguments?.length ?? 0) === 0) {
        noArgDateCalls.push(node.getText(file));
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(noArgDateCalls).toEqual([]);
  });

  it('feedback Agent 工具不使用宽松 parseDateArg，sentAt 原字符串交给确认 Gateway（严格 RFC3339 校验）', () => {
    // P29-W1：feedback.updateStatus 已改为可信确认，工具不再直接调用 owner service；
    // sentAt 原字符串交给 ConfirmationGateway.feedbackStatusIntent 保存（仅严格 RFC3339
    // 校验，不预解析不宽松转换），确认 executor 再以 parseRfc3339Instant 严格解析。
    const tools = source('app/tools/register-feedback-tools.ts');
    expect(importedNames(tools)).not.toContain('parseDateArg');
    expect(callsNamed(tools, 'parseDateArg')).toEqual([]);
    // 工具不再直接调用 owner service（P29-W1 fail-closed handler）
    expect(tools.getText()).not.toContain('feedback.updateFeedbackStatus');
    expect(tools.getText()).not.toContain('sentAt: a.sentAt');

    const gateway = source('app/confirmation/confirmation-gateway.ts');
    expect(importedNames(gateway)).toContain('parseRfc3339Instant');
    expect(gateway.getText()).toContain("actionName: 'feedback.updateStatus'");
    expect(gateway.getText()).toContain('...(sentAt !== undefined && { sentAt })');
  });

  it('composition 将同一 TrustedClock 实例传入 feedback 工具注册', () => {
    const file = source('app/tool-registration.ts');
    const registrations = callsNamed(file, 'registerFeedbackTools');
    expect(registrations).toHaveLength(1);
    const argumentsText = registrations[0].arguments.map((argument) => argument.getText(file));
    expect(argumentsText).toHaveLength(4);
    expect(argumentsText.slice(0, 3)).toEqual(['registry', 'prisma', 'trustedClock']);
    expect(argumentsText[3]).toContain("options.moderation?.provider === 'local'");
    expect(argumentsText[3]).toContain('logger: options.logger');
  });
});
