import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@data': resolve(repoRoot, 'data') },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    /*
     * ★テストは絶対に Firebase へ繋がない（T47）。
     *   .env.local が読まれると本物のプロジェクトを叩いてしまうので、
     *   ここで空にして「設定のない端末」として動かす。
     */
    env: {
      VITE_FIREBASE_API_KEY: '',
      VITE_FIREBASE_PROJECT_ID: '',
      VITE_FIREBASE_APP_ID: '',
    },
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/test/setup.ts'],
    // jsdom を並列に立てすぎるとメモリを食い潰す。
    // ファイルごとの隔離は保ったまま、同時に走る数だけ絞る。
    pool: 'forks',
    poolOptions: { forks: { maxForks: 2 } },
  },
});
