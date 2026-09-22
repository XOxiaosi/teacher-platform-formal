import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(__dirname, '../../src', path), 'utf8');

describe('A5-I8 HTTP edit adapter boundaries', () => {
  it('keeps edit.routes dependent only on application ports and shared HTTP helpers', () => {
    const route = source('app/routes/edit.routes.ts');

    expect(route).toContain("from '../composition/types.js'");
    expect(route).toContain("from './api-helpers.js'");
    expect(route).not.toMatch(/@prisma|Prisma|features\//);
    expect(route).not.toMatch(/\.(create|update|delete|upsert)\s*\(/);
    expect(route).not.toMatch(/\.\.\.\s*req\.body/);
  });

  it('assembles all six typed commands from an explicit rawPrisma port', () => {
    const composition = source('app/composition/core-route-dependencies.ts');
    const expectedFactories = [
      'createUpdateStudentProfileUseCase',
      'createRescheduleLessonUseCase',
      'createUpdateLessonRecordUseCase',
      'createUpdatePaymentUseCase',
      'createUpdateMemoUseCase',
      'createUpdateParentFeedbackContentUseCase',
    ];

    for (const factory of expectedFactories) {
      expect(composition).toContain(factory);
    }
    expect(composition.match(/rawPrisma/g)?.length).toBeGreaterThanOrEqual(7);
    expect(composition).not.toMatch(/rawPrisma\s*=\s*options\?\.rawPrisma\s*\?\?\s*prisma/);
    expect(composition).toMatch(/options\?\.rawPrisma\s*\?/);
  });

  it('mounts the edit router in core routing and passes raw Prisma independently of confirmation', () => {
    const coreRoutes = source('app/routes/core.routes.ts');
    const index = source('index.ts');

    expect(coreRoutes).toContain('createEditRouter');
    expect(coreRoutes).toMatch(/if \(dependencies\.edits\)[\s\S]*createEditRouter\(dependencies\.edits,\s*\{/);
    expect(index).toMatch(/createCoreRouter\(client,\s*\{[\s\S]*rawPrisma:\s*editRawPrisma/);
    expect(index).toContain('const editRawPrisma = options?.rawPrisma');
    expect(index).toContain('const confirmationPrisma = options?.rawPrisma ?? (client === prisma ? basePrisma : client)');
  });
});
