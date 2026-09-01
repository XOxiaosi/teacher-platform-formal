import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * 后台管理前端（packages/admin）构建配置。
 * - base '/admin/'：产物由 nginx 按 /admin/ 前缀托管（p7-admin-panel-design.md §1.1）
 * - dev 5174 + proxy /api → 127.0.0.1:3000（与教师端 dev 联调同源）
 */
export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
});
