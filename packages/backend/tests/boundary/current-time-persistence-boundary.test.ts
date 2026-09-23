import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = resolve(process.cwd(), 'src');

type CurrentTimeApi = 'NEW_DATE' | 'CALL_DATE' | 'DATE_NOW';

interface CurrentTimeFingerprint {
  file: string;
  api: CurrentTimeApi;
  owner: string;
  objectField: string;
}

type AllowedCurrentTimeUse = CurrentTimeFingerprint & {
  purpose: 'HEALTH_RESPONSE' | 'LOCAL_FILENAME' | 'LOG_TIMESTAMP' | 'BUDGET_WINDOW' | 'CACHE_WINDOW' | 'USAGE_WALL_CLOCK' | 'WEBHOOK_TIMESTAMP_WINDOW';
};

type CurrentTimeDebt = CurrentTimeFingerprint & {
  disposition: 'SEALED_UNREACHABLE';
};

const ALLOWLIST: readonly AllowedCurrentTimeUse[] = [
  {
    file: 'app/routes/health.routes.ts',
    api: 'NEW_DATE',
    owner: 'healthHandler',
    objectField: 'timestamp',
    purpose: 'HEALTH_RESPONSE',
  },
  {
    file: 'app/routes/health.routes.ts',
    api: 'NEW_DATE',
    owner: 'readinessResponse',
    objectField: 'timestamp',
    purpose: 'HEALTH_RESPONSE',
  },
  {
    file: 'shared/storage/storage.ts',
    api: 'DATE_NOW',
    owner: 'buildFileRef',
    objectField: '<none>',
    purpose: 'LOCAL_FILENAME',
  },
  {
    // 日志时间戳（P7 G1 logger 工厂 ts 字段）：运维可观测性墙钟元数据，非业务时间。
    // 业务时间纪律（TrustedClock / D47 可信时间）不受影响——日志仅用于
    // 排障/审计关联（requestId/teacherId/durationMs），不参与任何业务判定。
    file: 'shared/logger/logger.ts',
    api: 'NEW_DATE',
    owner: 'emit',
    objectField: 'ts',
    purpose: 'LOG_TIMESTAMP',
  },
  {
    // Agent 成本控制（P2 t48）预算窗口记账：checkAndConsume/usedToday 的
    // `now = new Date()` 默认参数用于「每日 token 预算按本地日期重置」——
    // 运维侧成本控制墙钟，非业务时间；业务时间纪律（TrustedClock）不受影响。
    file: 'shared/agent-cost/agent-cost.ts',
    api: 'NEW_DATE',
    owner: 'checkAndConsume',
    objectField: 'checkAndConsume',
    purpose: 'BUDGET_WINDOW',
  },
  {
    file: 'shared/agent-cost/agent-cost.ts',
    api: 'NEW_DATE',
    owner: 'usedToday',
    objectField: 'usedToday',
    purpose: 'BUDGET_WINDOW',
  },
  {
    // Provider 配置缓存（P7 渠道线 t66）：cachedConfigs/resolve 的 Date.now()
    // 用于 registryCacheTtlMs 缓存窗口（60s）——运维侧缓存墙钟，非业务时间；
    // 业务时间纪律（TrustedClock）不受影响。
    file: 'shared/ai-client/provider-router.ts',
    api: 'DATE_NOW',
    owner: 'cachedConfigs',
    objectField: '<none>',
    purpose: 'CACHE_WINDOW',
  },
  {
    file: 'shared/ai-client/provider-router.ts',
    api: 'DATE_NOW',
    owner: 'resolve',
    objectField: 'fetchedAt',
    purpose: 'CACHE_WINDOW',
  },
  {
    // Provider 用量采集（P7 渠道线 t69）：record 的 `requestAt ?? new Date()`
    // 默认参数用于用量记录请求时刻——运维侧用量墙钟，非业务时间；
    // 业务时间纪律（TrustedClock / D47 可信时间）不受影响。
    file: 'features/provider-usage/provider-usage-service.ts',
    api: 'NEW_DATE',
    owner: 'record',
    objectField: 'requestAt',
    purpose: 'USAGE_WALL_CLOCK',
  },
  {
    // 微信回调验签（P8 t9）：webhook timestamp 窗口判定（±5min 防重放）——
    // 运维侧墙钟元数据，非业务时间；业务时间纪律（TrustedClock）不受影响。
    // state TTL 用 performance.now()（login-state-store），不走本墙钟。
    file: 'features/wechat/signature.ts',
    api: 'DATE_NOW',
    owner: 'wallClockNowMs',
    objectField: '<none>',
    purpose: 'WEBHOOK_TIMESTAMP_WINDOW',
  },
];

const DEBT_LEDGER: readonly CurrentTimeDebt[] = [];

function fingerprintOf(entry: AllowedCurrentTimeUse | CurrentTimeDebt): CurrentTimeFingerprint {
  return {
    file: entry.file,
    api: entry.api,
    owner: entry.owner,
    objectField: entry.objectField,
  };
}

function collectTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? collectTypeScriptFiles(path) : path;
    })
    .filter((path) => path.endsWith('.ts'))
    .sort();
}

function propertyNameText(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function isGlobalThis(expression: ts.Expression): boolean {
  return ts.isIdentifier(expression) && expression.text === 'globalThis';
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isDateReference(expression: ts.Expression): boolean {
  const candidate = unwrapParentheses(expression);
  if (ts.isIdentifier(candidate)) return candidate.text === 'Date';
  if (ts.isPropertyAccessExpression(candidate)) {
    return isGlobalThis(candidate.expression) && candidate.name.text === 'Date';
  }
  return ts.isElementAccessExpression(candidate) && isGlobalThis(candidate.expression)
    && ts.isStringLiteral(candidate.argumentExpression)
    && candidate.argumentExpression.text === 'Date';
}

function isDateNowReference(expression: ts.Expression): boolean {
  const candidate = unwrapParentheses(expression);
  if (ts.isPropertyAccessExpression(candidate)) {
    return candidate.name.text === 'now' && isDateReference(candidate.expression);
  }
  return ts.isElementAccessExpression(candidate)
    && ts.isStringLiteral(candidate.argumentExpression)
    && candidate.argumentExpression.text === 'now'
    && isDateReference(candidate.expression);
}

function forbiddenDateBinding(node: ts.Node): string | undefined {
  if (ts.isVariableDeclaration(node)) {
    if (ts.isIdentifier(node.name)) {
      if (node.name.text === 'Date') return '局部绑定遮蔽全局Date';
      if (node.initializer && (isDateReference(node.initializer) || isDateNowReference(node.initializer))) {
        return `禁止Date API别名:${node.name.text}`;
      }
    }
    if (ts.isObjectBindingPattern(node.name) && node.initializer) {
      const source = unwrapParentheses(node.initializer);
      const importedNames = node.name.elements.map((element) =>
        propertyNameText(element.propertyName)
        ?? (ts.isIdentifier(element.name) ? element.name.text : undefined));
      if ((isGlobalThis(source) && importedNames.includes('Date'))
        || (isDateReference(source) && importedNames.includes('now'))) {
        return '禁止解构Date API别名';
      }
    }
  }
  if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
    if (node.name.text === 'Date') return '参数遮蔽全局Date';
    if (node.initializer && (isDateReference(node.initializer) || isDateNowReference(node.initializer))) {
      return `禁止Date API默认参数别名:${node.name.text}`;
    }
  }
  if (ts.isBinaryExpression(node)
    && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && (isDateReference(node.right) || isDateNowReference(node.right))) {
    return `禁止Date API赋值别名:${node.left.getText()}`;
  }
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === 'Date') {
    return '声明遮蔽全局Date';
  }
  if (ts.isImportSpecifier(node) && node.name.text === 'Date') return '导入遮蔽全局Date';
  if (ts.isImportClause(node) && node.name?.text === 'Date') return '导入遮蔽全局Date';
  if (ts.isNamespaceImport(node) && node.name.text === 'Date') return '导入遮蔽全局Date';
  return undefined;
}

function classifyCurrentTime(node: ts.Node): CurrentTimeApi | undefined {
  if (ts.isNewExpression(node) && isDateReference(node.expression) && (node.arguments?.length ?? 0) === 0) {
    return 'NEW_DATE';
  }
  if (!ts.isCallExpression(node) || node.arguments.length !== 0) return undefined;
  if (isDateReference(node.expression)) return 'CALL_DATE';
  if (isDateNowReference(node.expression)) return 'DATE_NOW';
  return undefined;
}

function nearestOwner(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current)) return propertyNameText(current.name) ?? '<computed-method>';
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent;
      if (ts.isPropertyAssignment(parent)) return propertyNameText(parent.name) ?? '<computed-property-function>';
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
      if (ts.isCallExpression(parent)) return `${parent.expression.getText()} callback`;
      return '<anonymous-function>';
    }
  }
  return '<module>';
}

function nearestObjectField(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isPropertyAssignment(current)) return propertyNameText(current.name) ?? '<computed-field>';
    if (ts.isMethodDeclaration(current)) return propertyNameText(current.name) ?? '<computed-method>';
  }
  return '<none>';
}

function scanSourceText(relativeFile: string, source: string): {
  fingerprints: CurrentTimeFingerprint[];
  forbiddenBindings: string[];
} {
  const fingerprints: CurrentTimeFingerprint[] = [];
  const forbiddenBindings: string[] = [];
  const sourceFile = ts.createSourceFile(relativeFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    const bindingViolation = forbiddenDateBinding(node);
    if (bindingViolation) forbiddenBindings.push(`${relativeFile}|${bindingViolation}`);
    const api = classifyCurrentTime(node);
    if (api) {
      fingerprints.push({
        file: relativeFile,
        api,
        owner: nearestOwner(node),
        objectField: nearestObjectField(node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { fingerprints, forbiddenBindings };
}

function scanCurrentTimeBoundary(): {
  fingerprints: CurrentTimeFingerprint[];
  forbiddenBindings: string[];
} {
  const fingerprints: CurrentTimeFingerprint[] = [];
  const forbiddenBindings: string[] = [];

  for (const filePath of collectTypeScriptFiles(SOURCE_ROOT)) {
    const relativeFile = relative(SOURCE_ROOT, filePath).replaceAll('\\', '/');
    const result = scanSourceText(relativeFile, readFileSync(filePath, 'utf8'));
    fingerprints.push(...result.fingerprints);
    forbiddenBindings.push(...result.forbiddenBindings);
  }

  return {
    fingerprints: fingerprints.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    forbiddenBindings: forbiddenBindings.sort(),
  };
}

describe('persistent current-time source boundary', () => {
  let currentBoundary: ReturnType<typeof scanCurrentTimeBoundary>;

  beforeAll(() => {
    // Both assertions must inspect one stable source snapshot. Keeping the
    // repository-wide scan in the existing 30-second hook budget also avoids
    // running the same synchronous filesystem/AST work twice under full load.
    currentBoundary = scanCurrentTimeBoundary();
  });

  it('扫描器识别括号调用并拒绝声明、解构、赋值与默认参数别名', () => {
    const direct = scanSourceText('probe-direct.ts', `
      function probe() {
        return [(Date.now)(), (globalThis.Date.now)(), new (Date)(), (Date)()];
      }
    `);
    expect(direct.fingerprints.map((item) => item.api).sort()).toEqual([
      'CALL_DATE', 'DATE_NOW', 'DATE_NOW', 'NEW_DATE',
    ]);

    const aliases = scanSourceText('probe-alias.ts', `
      const D = Date;
      const now = Date.now;
      const { Date: GlobalDate } = globalThis;
      const { now: dateNow } = Date;
      let Later;
      Later = Date;
      function withDefault(DefaultDate = Date) { return DefaultDate; }
      function withShadow(Date: unknown) { return Date; }
    `);
    expect(aliases.forbiddenBindings).toHaveLength(7);
  });

  it('禁止Date API别名与局部遮蔽，避免绕过直接调用扫描', () => {
    expect(currentBoundary.forbiddenBindings).toEqual([]);
  });

  it('每个无参当前时间生成都被精确归入allowlist或债务ledger', () => {
    const actual = currentBoundary.fingerprints;
    const allowlistFingerprints = ALLOWLIST.map(fingerprintOf);
    const debtFingerprints = DEBT_LEDGER.map(fingerprintOf);
    const expected = [...allowlistFingerprints, ...debtFingerprints]
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

    expect(ALLOWLIST).toHaveLength(10);
    expect(DEBT_LEDGER).toHaveLength(0);
    expect(new Set(actual.map((item) => JSON.stringify(item))).size).toBe(actual.length);
    expect(allowlistFingerprints.filter((item) => debtFingerprints.some((debt) => JSON.stringify(debt) === JSON.stringify(item)))).toEqual([]);
    expect(actual).toEqual(expected);
  });
});
