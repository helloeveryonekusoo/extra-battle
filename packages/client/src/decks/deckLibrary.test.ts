/**
 * T47: デッキの置き場。
 *
 * ★ここで守りたいこと。
 *   1. ログアウト中は今までどおりこの端末に保存される（第2段階のしくみを壊さない）
 *   2. Firestore のルールで弾かれる前に、理由の分かる形で止める
 *   3. アカウントに引き上げても、同じ名前のデッキが増殖しない
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { checkDeck, deleteDeckFrom, loadLibrary, saveDeckTo, MAX_DECK_LINES } from './deckLibrary';
import { listSavedDecks } from './deckStorage';

const cards = [{ functionalId: 'x-mon', count: 4 }];

beforeEach(() => {
  window.localStorage.clear();
});

describe('保存前の検査（★ルールで弾かれる前に止める）', () => {
  it('名前が空なら止める', () => {
    expect(checkDeck({ name: '   ', cards })).toBe('デッキ名を入れてください');
  });

  it('名前が長すぎれば止める', () => {
    expect(checkDeck({ name: 'あ'.repeat(61), cards })).toContain('60文字まで');
  });

  it('カードの種類が多すぎれば止める', () => {
    const many = Array.from({ length: MAX_DECK_LINES + 1 }, (_, i) => ({
      functionalId: `x-${i}`,
      count: 1,
    }));
    expect(checkDeck({ name: 'ok', cards: many })).toContain('種類まで');
  });

  it('ふつうのデッキは通る', () => {
    expect(checkDeck({ name: 'こくば', cards })).toBeNull();
  });
});

describe('ログアウト中はこの端末に保存する', () => {
  it('保存・一覧・削除がひととおりできる', async () => {
    const saved = await saveDeckTo(null, { name: 'テストデッキ', cards });
    expect(saved.id).toBeTruthy();

    const library = await loadLibrary(null);
    expect(library.where).toBe('local');
    expect(library.error).toBeNull();
    expect(library.decks.map((d) => d.name)).toEqual(['テストデッキ']);

    await deleteDeckFrom(null, saved.id);
    expect((await loadLibrary(null)).decks).toEqual([]);
  });

  it('★同じIDで保存し直すと上書きされる（増えない）', async () => {
    const first = await saveDeckTo(null, { name: 'A', cards });
    await saveDeckTo(null, { name: 'A（改）', cards }, first.id);

    const decks = listSavedDecks();
    expect(decks).toHaveLength(1);
    expect(decks[0]?.name).toBe('A（改）');
  });

  it('★検査に落ちるデッキは保存しない', async () => {
    await expect(saveDeckTo(null, { name: '', cards })).rejects.toThrow('デッキ名');
    expect(listSavedDecks()).toEqual([]);
  });
});

describe('Firebase の設定がない端末', () => {
  it('★ログインしていても、この端末の置き場にそのまま落ちる（アプリを止めない）', async () => {
    // テスト環境には Firebase の設定がないので firestore() は null になる
    const saved = await saveDeckTo('uid-1', { name: 'ローカル退避', cards });
    expect(listSavedDecks().map((d) => d.id)).toContain(saved.id);

    const library = await loadLibrary('uid-1');
    expect(library.where).toBe('local');
    expect(library.decks.map((d) => d.name)).toEqual(['ローカル退避']);
  });
});
