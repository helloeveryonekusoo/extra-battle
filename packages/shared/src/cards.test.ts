import { describe, expect, it } from 'vitest';
import {
  buildCardIndex,
  canonicalName,
  CardDataError,
  computeFunctionalId,
  parseCardTexts,
} from './cards';
import type { CardText } from './types';

const pikachu: CardText = {
  functionalId: 'x',
  name: 'ピカチュウ',
  supertype: 'pokemon',
  hp: 60,
  types: ['lightning'],
  stage: 'basic',
  ruleBox: null,
  attacks: [{ name: 'でんきショック', cost: ['lightning'], damage: '20', text: '' }],
  weakness: { type: 'fighting', modifier: '×2' },
  resistance: null,
  retreatCost: 1,
};

describe('parseCardTexts', () => {
  it('正しいカードを通す', () => {
    const cards = parseCardTexts([pikachu]);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.effects).toBeNull();
  });

  it('effects のDSLを検証し、nullはMANUAL定義として通す', () => {
    expect(parseCardTexts([{ ...pikachu, effects: null }])[0]?.effects).toBeNull();
    expect(
      parseCardTexts([{ ...pikachu, effects: [{ op: 'draw', player: 'self', count: 1 }] }])[0]
        ?.effects,
    ).toEqual([{ op: 'draw', player: 'self', count: 1 }]);
    expect(() =>
      parseCardTexts([{ ...pikachu, effects: [{ op: 'draw', player: 'self' }] }]),
    ).toThrow(/effects/);
  });

  it('functionalId の重複を弾く', () => {
    expect(() => parseCardTexts([pikachu, { ...pikachu }])).toThrow(CardDataError);
  });

  it('画像やフレーバーテキストを持つカードを弾く（絶対制約）', () => {
    expect(() => parseCardTexts([{ ...pikachu, imageUrl: 'x' }])).toThrow(/絶対制約/);
    expect(() => parseCardTexts([{ ...pikachu, flavorText: 'x' }])).toThrow(/絶対制約/);
  });

  it('たね以外に evolvesFrom がないと弾く', () => {
    expect(() =>
      parseCardTexts([{ ...pikachu, functionalId: 'y', stage: 'stage1' }]),
    ).toThrow(/evolvesFrom/);
  });

  it('問題をまとめて報告する', () => {
    try {
      parseCardTexts([{ ...pikachu, hp: 0, retreatCost: -1 }]);
      expect.unreachable('例外が投げられていない');
    } catch (e) {
      expect(e).toBeInstanceOf(CardDataError);
      expect((e as CardDataError).issues.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('computeFunctionalId', () => {
  it('同じ内容なら同じ id になる', () => {
    expect(computeFunctionalId(pikachu)).toBe(computeFunctionalId({ ...pikachu }));
  });

  it('印刷差（全角半角・空白）を吸収する', () => {
    const spaced: CardText = {
      ...pikachu,
      attacks: [{ name: 'でんき ショック', cost: ['lightning'], damage: '２０', text: '' }],
    };
    expect(computeFunctionalId(spaced)).toBe(computeFunctionalId(pikachu));
  });

  it('ワザのダメージが違えば別の id になる', () => {
    const stronger: CardText = {
      ...pikachu,
      attacks: [{ name: 'でんきショック', cost: ['lightning'], damage: '30', text: '' }],
    };
    expect(computeFunctionalId(stronger)).not.toBe(computeFunctionalId(pikachu));
  });
});

describe('索引とエイリアス（§5.1-6 / §5.1-7）', () => {
  it('4枚制限は name、エンジンは functionalId で引く', () => {
    // 同名だが効果が違う別版（例: 収録違い）
    const reprint: CardText = { ...pikachu, functionalId: 'z', retreatCost: 2 };
    const index = buildCardIndex([pikachu, reprint]);

    expect(index.byName.get('ピカチュウ')).toHaveLength(2);
    expect(index.byFunctionalId.get('x')?.retreatCost).toBe(1);
    expect(index.byFunctionalId.get('z')?.retreatCost).toBe(2);
  });

  it('同名エイリアス表で正規化名に寄せられる', () => {
    const aliases = { 'ボスの指令（サカキ）': 'ボスの指令', 'ボスの指令（アカギ）': 'ボスの指令' };
    expect(canonicalName('ボスの指令（サカキ）', aliases)).toBe('ボスの指令');
    expect(canonicalName('ボスの指令（アカギ）', aliases)).toBe('ボスの指令');
    expect(canonicalName('ハイパーボール', aliases)).toBe('ハイパーボール');
  });
});
