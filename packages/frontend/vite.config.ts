import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        preview: resolve(import.meta.dirname, 'preview.html'),
        prototypeV009: resolve(import.meta.dirname, 'prototype-v009.html'),
        assistantWorkbench: resolve(import.meta.dirname, 'assistant-workbench.html'),
        designReview: resolve(import.meta.dirname, 'design-review.html'),
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
