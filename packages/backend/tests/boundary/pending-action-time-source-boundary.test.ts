import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCE_PATH = resolve(process.cwd(), 'src/features/pending-action/pending-action-execution-store.ts');

function source(): ts.SourceFile {
  return ts.createSourceFile(SOURCE_PATH, readFileSync(SOURCE_PATH, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function updateManyDataObjects(node: ts.SourceFile): ts.ObjectLiteralExpression[] {
  const objects: ts.ObjectLiteralExpression[] = [];
  const visit = (current: ts.Node): void => {
    if (
      ts.isCallExpression(current)
      && ts.isPropertyAccessExpression(current.expression)
      && current.expression.name.text === 'updateMany'
    ) {
      const argument = current.arguments[0];
      if (argument && ts.isObjectLiteralExpression(argument)) {
        const dataProperty = argument.properties.find(
          (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'data',
        );
        if (dataProperty && ts.isObjectLiteralExpression(dataProperty.initializer)) {
          objects.push(dataProperty.initializer);
        }
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return objects;
}

function dataHasUpdatedAt(data: ts.ObjectLiteralExpression): boolean {
  return data.properties.some(
    (property) =>
      ts.isPropertyAssignment(property)
      && ts.isIdentifier(property.name)
      && property.name.text === 'updatedAtTs',
  );
}

function dataFieldKeys(data: ts.ObjectLiteralExpression): string[] {
  return data.properties
    .filter(ts.isPropertyAssignment)
    .map((property) => (ts.isIdentifier(property.name) ? property.name.text : '<computed>'));
}

describe('PendingAction 状态变更时间源静态边界', () => {
  it('execution store 四处 updateMany 均显式写入 updatedAt，不依赖 @updatedAt 注入', () => {
    const updateManyDatas = updateManyDataObjects(source());

    expect(updateManyDatas).toHaveLength(4);
    for (const data of updateManyDatas) {
      expect(dataHasUpdatedAt(data)).toBe(true);
    }
  });

  it('markConsumed 写入 consumedAt+updatedAt，cancel 写入 cancelledAt+updatedAt', () => {
    const updateManyDatas = updateManyDataObjects(source());
    const allKeys = updateManyDatas.map(dataFieldKeys);

    expect(allKeys).toContainEqual(expect.arrayContaining(['status', 'consumedAtTs', 'updatedAtTs']));
    expect(allKeys).toContainEqual(expect.arrayContaining(['status', 'cancelledAtTs', 'updatedAtTs']));
    expect(allKeys).toContainEqual(['status', 'updatedAtTs']);
  });
});
