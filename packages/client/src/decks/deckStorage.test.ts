import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DECK_FILE_FORMAT,
  deleteDeck,
  listSavedDecks,
  parseDeckFile,
  saveDeck,
  serializeDeck,
} from './deckStorage';

describe('デッキ保存とJSON入出力', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T01:00:00.000Z'));
  });

  afterEach(() => vi.useRealTimers());

  it('保存・更新・削除ができる', () => {
    const first = saveDeck({ name: 'テスト', cards: [{ functionalId: 'a', count: 4 }] });
    expect(listSavedDecks()).toHaveLength(1);
    saveDeck({ name: '更新版', cards: [{ functionalId: 'b', count: 2 }] }, first.id);
    expect(listSavedDecks()).toMatchObject([{ id: first.id, name: '更新版' }]);
    deleteDeck(first.id);
    expect(listSavedDecks()).toEqual([]);
  });

  it('自前形式で往復し、重複IDの枚数をまとめる', () => {
    const json = serializeDeck({
      name: 'JSONデッキ',
      cards: [
        { functionalId: 'a', count: 2 },
        { functionalId: 'a', count: 1 },
      ],
    });
    expect(JSON.parse(json).format).toBe(DECK_FILE_FORMAT);
    expect(parseDeckFile(json)).toEqual({
      name: 'JSONデッキ',
      cards: [{ functionalId: 'a', count: 3 }],
    });
  });

  it('別形式や壊れたJSONを拒否する', () => {
    expect(() => parseDeckFile('{')).toThrow('JSON');
    expect(() => parseDeckFile('{"format":"other","version":1}')).toThrow('デッキJSON');
  });
});
