import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

/*
 * ★GitHub Pages はリポジトリ名の下に置かれる（/<repo>/）ので、
 *   資材の参照先をそこに合わせる必要がある。既定は '/'（手元・独自ドメイン用）。
 *   公開の workflow が VITE_BASE を渡す。
 */
const base = process.env['VITE_BASE'] ?? '/';

export default defineConfig({
  base,
  plugins: [react()],
  resolve: {
    alias: {
      // T7/T8 のデモ画面がサンプルカードを直接読むための入口。
      // 本番の対戦では状態はすべてサーバーから来る（T6）。
      '@data': resolve(repoRoot, 'data'),
    },
  },
  server: {
    // プライベートネットワーク（Tailscale）上の別端末から開けるようにする
    host: true,
    port: 5173,
    fs: {
      allow: [repoRoot],
    },
  },
});
