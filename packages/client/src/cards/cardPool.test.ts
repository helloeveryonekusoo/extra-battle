/**
 * T45: カードデータを手元に読み込む。
 *
 * ★アプリに同梱しないので、ここが唯一の入口になる。
 *   読めない・壊れているときにアプリを止めないことも合わせて確かめる。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { CardText } from '@pokeca/shared';
import {
  CARD_POOL_KEY,
  clearCardPool,
  loadCardPool,
  readCardFile,
  saveCardPool,
} from './cardPool';

const MON: CardText = {
  functionalId: 'x-mon',
  name: 'テストポケモン',
  supertype: 'pokemon',
  hp: 60,
  types: ['water'],
  stage: 'basic',
  ruleBox: null,
  attacks: [],
  weakness: null,
  resistance: null,
  retreatCost: 1,
};

const ITEM: CardText = {
  functionalId: 'x-item',
  name: 'テストグッズ',
  supertype: 'trainer',
  trainerKind: 'item',
  text: '山札を1枚引く。',
};

beforeEach(() => {
  window.localStorage.clear();
});

describe('カードプール', () => {
  it('読み込む前は空。アプリは止まらない', () => {
    const pool = loadCardPool();
    expect(pool.index.all).toEqual([]);
    expect(pool.sources).toEqual([]);
    expect(pool.updatedAt).toBeNull();
  });

  it('読み込むと保存され、次に開いたときも残っている', () => {
    saveCardPool([{ name: 'a.json', cards: [MON, ITEM] }]);
    const pool = loadCardPool();
    expect(pool.index.all).toHaveLength(2);
    expect(pool.index.byName.get('テストポケモン')?.[0]?.hp).toBe(60);
    expect(pool.sources).toEqual(['a.json']);
    expect(pool.updatedAt).not.toBeNull();
  });

  it('★あとから読んだファイルで同じカードを差し替えられる', () => {
    saveCardPool([{ name: 'a.json', cards: [MON] }]);
    const updated: CardText = { ...MON, hp: 90 };
    const pool = saveCardPool([{ name: 'b.json', cards: [updated] }]);

    expect(pool.index.all).toHaveLength(1);
    expect(pool.index.byFunctionalId.get('x-mon')?.hp).toBe(90);
    expect(pool.sources).toEqual(['a.json', 'b.json']);
  });

  it('複数ファイルをまとめて足せる', () => {
    saveCardPool([{ name: 'a.json', cards: [MON] }]);
    const pool = saveCardPool([{ name: 'b.json', cards: [ITEM] }]);
    expect(pool.index.all).toHaveLength(2);
  });

  it('すべて削除できる', () => {
    saveCardPool([{ name: 'a.json', cards: [MON] }]);
    expect(clearCardPool().index.all).toEqual([]);
    expect(loadCardPool().index.all).toEqual([]);
  });

  it('★保存が壊れていても空として扱う（アプリを止めない）', () => {
    window.localStorage.setItem(CARD_POOL_KEY, '{ こわれている');
    expect(loadCardPool().index.all).toEqual([]);

    window.localStorage.setItem(CARD_POOL_KEY, JSON.stringify({ version: 1 }));
    expect(loadCardPool().index.all).toEqual([]);
  });

  it('JSONを読むときは共有の検証を通す（壊れたデータは弾く）', () => {
    const good = readCardFile('ok.json', JSON.stringify([MON]));
    expect(good.cards).toHaveLength(1);

    // ★絶対制約に反するキーは読み込み時に落ちる
    expect(() =>
      readCardFile('ng.json', JSON.stringify([{ ...MON, imageUrl: 'http://example.com/a.png' }])),
    ).toThrow();
  });
});
