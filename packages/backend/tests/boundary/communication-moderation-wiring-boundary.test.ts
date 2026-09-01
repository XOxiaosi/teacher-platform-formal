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

function callsMethodNamed(file: ts.SourceFile, name: string): ts.CallExpression[] {
  const matches: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === name) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return matches;
}

function communicationServiceCall(file: ts.SourceFile): ts.CallExpression {
  const calls = callsNamed(file, 'createCommunicationService');
  expect(calls).toHaveLength(1);
  return calls[0];
}

describe('Communication moderation trusted wiring boundary', () => {
  it('HTTP composition 仅向 local adapter 注入审核依赖，并固定 manual 审计来源', () => {
    const file = source('app/composition/core-route-dependencies.ts');
    const text = file.getText();
    const callText = communicationServiceCall(file).arguments[0]?.getText(file) ?? '';

    expect(text).toContain("platformServices.moderation?.provider === 'local'");
    expect(callText).toContain('...(communicationModeration');
    expect(callText).toContain('moderation: communicationModeration');
    expect(callText).toContain('logger: options?.logger ?? createLogger()');
    expect(callText).toContain("auditSource: 'manual'");
    expect(callText).not.toContain('auditSource: options');
  });

  it('Agent composition 仅向 local adapter 注入审核依赖，并固定 agent 审计来源', () => {
    const file = source('app/tool-registration.ts');
    const text = file.getText();
    const callText = communicationServiceCall(file).arguments[0]?.getText(file) ?? '';

    expect(text).toContain("options.moderation?.provider === 'local'");
    expect(callText).toContain('...(communicationModeration');
    expect(callText).toContain('moderation: communicationModeration');
    expect(callText).toContain('logger: options.logger');
    expect(callText).toContain("auditSource: 'agent'");
    expect(callText).not.toContain('auditSource: options');
  });

  it('Agent communication capture 请求契约不暴露 auditSource 伪造入口', () => {
    const file = source('app/tools/register-student-records-tools.ts');
    const captureRegistration = callsMethodNamed(file, 'register').find((call) =>
      call.arguments[0]?.getText(file).includes("name: 'students.communications.capture'"));

    expect(captureRegistration).toBeDefined();
    const definitionText = captureRegistration!.arguments[0]?.getText(file) ?? '';
    expect(definitionText).toContain("required: ['studentId', 'rawText']");
    expect(definitionText).not.toContain('auditSource');
  });
});
