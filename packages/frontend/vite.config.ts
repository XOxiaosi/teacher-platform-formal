import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        preview: resolve(import.meta.dirname, 'preview.html'),
        prototypeV009: resolve(import.meta.dirname, 'prototype-v009.html'),
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': process.env.VITE_BACKEND_PROXY ?? 'http://127.0.0.1:3001',
    },
  },
  test: {
    // Bound concurrent jsdom suites so DOM-heavy flows retain their 5s deadline.
    maxWorkers: 2,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
});
