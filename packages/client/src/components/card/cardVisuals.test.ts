/**
 * T51: カタログの並び順。
 *
 * ★守りたいのは「進化ラインが離れないこと」。
 *   名前順だと メッソン と インテレオン が別々の場所に出て、
 *   デッキを組むとき一覧を行き来することになる。
 */
import { describe, expect, it } from 'vitest';
import type { CardText } from '@pokeca/shared';
import { frameColor, groupOfCard, sortForCatalog } from './cardVisuals';

const pokemon = (
  name: string,
  stage: CardText['stage'],
  evolvesFrom?: string,
  type: 'water' | 'fire' = 'water',
): CardText =>
  ({
    functionalId: `p-${name}`,
    name,
    supertype: 'pokemon',
    stage,
    types: [type],
    hp: 60,
    ...(evolvesFrom ? { evolvesFrom } : {}),
  }) as CardText;

const trainer = (name: string, trainerKind: CardText['trainerKind']): CardText =>
  ({ functionalId: `t-${name}`, name, supertype: 'trainer', trainerKind }) as CardText;

const energy = (name: string, isBasicEnergy: boolean): CardText =>
  ({ functionalId: `e-${name}`, name, supertype: 'energy', isBasicEnergy }) as CardText;

describe('種類の判定', () => {
  it('ポケモン・エネルギー・トレーナーズの種類に分かれる', () => {
    expect(groupOfCard(pokemon('メッソン', 'basic'))).toBe('pokemon');
    expect(groupOfCard(trainer('クイックボール', 'item'))).toBe('item');
    expect(groupOfCard(trainer('博士の研究', 'supporter'))).toBe('supporter');
    expect(groupOfCard(energy('基本水エネルギー', true))).toBe('energy');
  });
});

describe('カタログの並び', () => {
  it('★進化ラインがまとまり、たねから順に並ぶ', () => {
    const sorted = sortForCatalog([
      pokemon('インテレオン', 'stage2', 'ジメレオン'),
      pokemon('メッソン', 'basic'),
      pokemon('ジメレオン', 'stage1', 'メッソン'),
    ]);
    expect(sorted.map((card) => card.name)).toEqual(['メッソン', 'ジメレオン', 'インテレオン']);
  });

  it('種類ごとにまとまる（ポケモン → グッズ → サポート → エネルギー）', () => {
    const sorted = sortForCatalog([
      energy('基本水エネルギー', true),
      trainer('博士の研究', 'supporter'),
      pokemon('メッソン', 'basic'),
      trainer('クイックボール', 'item'),
    ]);
    expect(sorted.map((card) => card.supertype)).toEqual([
      'pokemon',
      'trainer',
      'trainer',
      'energy',
    ]);
    expect(sorted[1]!.name).toBe('クイックボール');
  });

  it('タイプが違えばラインごと分かれる', () => {
    const sorted = sortForCatalog([
      pokemon('ヒトカゲ', 'basic', undefined, 'fire'),
      pokemon('メッソン', 'basic', undefined, 'water'),
    ]);
    // ENERGY_TYPES の並び（炎が水より先）に従う
    expect(sorted[0]!.name).toBe('ヒトカゲ');
  });

  it('基本エネルギーが特殊エネルギーより先に来る', () => {
    const sorted = sortForCatalog([
      energy('ツインエネルギー', false),
      energy('基本水エネルギー', true),
    ]);
    expect(sorted.map((card) => card.name)).toEqual(['基本水エネルギー', 'ツインエネルギー']);
  });

  it('元の配列を書き換えない', () => {
    const cards = [pokemon('ジメレオン', 'stage1', 'メッソン'), pokemon('メッソン', 'basic')];
    sortForCatalog(cards);
    expect(cards[0]!.name).toBe('ジメレオン');
  });
});

describe('枠の色', () => {
  it('トレーナーズは種類ごと、ポケモンはタイプで決まる', () => {
    expect(frameColor(trainer('クイックボール', 'item'))).toBe('var(--water)');
    expect(frameColor(trainer('博士の研究', 'supporter'))).toBe('var(--fire)');
    expect(frameColor(trainer('崩れたスタジアム', 'stadium'))).toBe('var(--grass)');
    expect(frameColor(pokemon('ヒトカゲ', 'basic', undefined, 'fire'))).toBe('var(--fire)');
  });
});
