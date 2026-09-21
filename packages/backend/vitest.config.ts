import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    root: '.',
    // 隔离 runner 只为一次 Vitest 运行创建一个临时数据库；测试文件仍共享该库，
    // 因而必须串行执行，避免全表清理（session/registry 等）跨文件互相污染。
    fileParallelism: false,
    // 部分套件会在 beforeAll/afterAll 中创建、迁移和回收独立教师库；完整 Gate 下
    // 41 个迁移可能超过 Vitest 默认 10 秒，但 30 秒仍能及时暴露真实挂起。
    hookTimeout: 30_000,
    // P8 phase-3 批1（t10）：测试统一注入 ENCRYPTION_KEY（不进 .env 提交）
    setupFiles: ['tests/setup/encryption-key.ts'],
  },
});
