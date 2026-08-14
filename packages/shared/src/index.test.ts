import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './index';

describe('shared パッケージの土台', () => {
  it('プロトコルバージョンを公開している', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('ルームコードの文字集合に紛らわしい文字を含まない', () => {
    for (const ch of ['0', 'O', '1', 'I']) {
      expect(ROOM_CODE_ALPHABET).not.toContain(ch);
    }
    expect(ROOM_CODE_LENGTH).toBeGreaterThan(0);
  });
});
