import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const backendRoot = fileURLToPath(new URL('../..', import.meta.url));

const obsoletePaths = [
  'src/app/use-cases/ai-route/ai-route-use-case.ts',
  'src/app/use-cases/ai-route/index.ts',
  'src/app/use-cases/ai-route/types.ts',
  'src/app/use-cases/create-recurring-schedule/create-recurring-schedule-use-case.ts',
  'src/app/use-cases/create-recurring-schedule/index.ts',
  'src/app/use-cases/create-recurring-schedule/types.ts',
  'tests/functional/use-cases/ai-route.test.ts',
  'tests/functional/use-cases/create-recurring-schedule.test.ts',
] as const;

const forbiddenPatterns = [
  {
    file: 'src/features/scheduling/index.ts',
    pattern: /\b(?:CreateRecurringScheduleInput|UpdateScheduleInput)\b/,
    label: 'obsolete scheduling barrel exports',
  },
  {
    file: 'src/features/scheduling/types.ts',
    pattern: /\b(?:createRecurringSchedule|updateSchedule)\s*\(/,
    label: 'obsolete ScheduleService methods',
  },
  {
    file: 'src/features/scheduling/types.ts',
    pattern: /\bCreateRecurringScheduleInput\b/,
    label: 'recurring schedule input contract',
  },
  {
    file: 'src/features/scheduling/types.ts',
    pattern: /\bUpdateScheduleInput\b/,
    label: 'generic schedule update input contract',
  },
  {
    file: 'src/features/scheduling/schedule-service.ts',
    pattern: /\basync createRecurringSchedule\s*\(/,
    label: 'recurring schedule service method',
  },
  {
    file: 'src/features/scheduling/schedule-service.ts',
    pattern: /\basync updateSchedule\s*\(/,
    label: 'generic schedule update service method',
  },
  {
    file: 'tests/functional/scheduling/schedule-service.test.ts',
    pattern: /describe\('scheduleService\.(?:createRecurringSchedule|updateSchedule)'/,
    label: 'obsolete scheduling service tests',
  },
  {
    file: 'tests/boundary/edge-conditions.test.ts',
    pattern: /createRecurringScheduleUseCase|周期排课批量创建/,
    label: 'recurring schedule edge test',
  },
] as const;

describe('生产不可达源码清理边界', () => {
  it.each(obsoletePaths)('旧路径已删除：%s', (relativePath) => {
    expect(existsSync(resolve(backendRoot, relativePath))).toBe(false);
  });

  it.each(forbiddenPatterns)('$label 已从 $file 移除', ({ file, pattern }) => {
    const source = readFileSync(resolve(backendRoot, file), 'utf8');
    expect(source).not.toMatch(pattern);
  });
});
