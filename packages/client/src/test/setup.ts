import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Node 22+ が実験的な global localStorage を持つ環境では、jsdom の Storage が
// undefined に置き換わることがある。ブラウザと同じ最小 API をテスト用に補う。
if (!window.localStorage) {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
}

// テスト間で DOM を持ち越さない。
// （プールの設定によっては同じ jsdom が使い回されるため、明示的に片付ける）
afterEach(() => {
  cleanup();
});
