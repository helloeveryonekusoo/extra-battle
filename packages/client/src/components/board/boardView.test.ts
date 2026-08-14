/**
 * T33: 盤面のエネルギーは「枚数」ではなく「何個ぶん」で描く。
 *
 * ★ダブル無色エネルギー1枚なら粒は2つ。
 *   ツインエネルギーをルールを持つポケモンにつけていれば、はたらかないので粒は0。
 */
import { describe, expect, it } from 'vitest';
import {
  applyActions,
  buildCardIndex,
  createGameState,
  withCards,
  type Action,
  type CardInstance,
  type CardText,
  type GameState,
} from '@pokeca/shared';
import { slotViewOf } from './boardView';

const BASIC: CardText = {
  functionalId: 'fn-basic',
  name: 'ゼニガメ',
  supertype: 'pokemon',
  hp: 70,
  types: ['water'],
  stage: 'basic',
  ruleBox: null,
  attacks: [],
  weakness: null,
  resistance: null,
  retreatCost: 1,
};

const RULE_MON: CardText = { ...BASIC, functionalId: 'fn-v', name: 'ゼニガメV', ruleBox: 'V' };

const WATER: CardText = {
  functionalId: 'fn-water',
  name: '基本水エネルギー',
  supertype: 'energy',
  isBasicEnergy: true,
  energyProvides: ['water'],
};

const DOUBLE: CardText = {
  functionalId: 'fn-dce',
  name: 'ダブル無色エネルギー',
  supertype: 'energy',
  isBasicEnergy: false,
  energyProvides: ['colorless'],
  text: '無色2個ぶん。',
  energyValue: [{ provides: ['colorless'], amount: 2, label: '無色2個ぶん' }],
};

const TWIN: CardText = {
  ...DOUBLE,
  functionalId: 'fn-twin',
  name: 'ツインエネルギー',
  energyValue: [
    { when: { ruleBox: 'any' }, provides: [], amount: 0, label: 'ルールを持つポケモンにはたらかない' },
    { provides: ['colorless'], amount: 2, label: '無色2個ぶん' },
  ],
};

const index = buildCardIndex([BASIC, RULE_MON, WATER, DOUBLE, TWIN]);

const ME = 'p-1';

const instance = (instanceId: string, functionalId: string): CardInstance => ({
  instanceId,
  functionalId,
  ownerId: ME,
  zone: 'hand',
  visibleTo: [ME],
  faceUp: false,
});

/** バトル場に pokemon を置き、energies をつけた盤面 */
function board(pokemonFid: string, energyFids: readonly string[]): GameState {
  const base = createGameState({
    gameId: 'g-view',
    rngSeed: 'seed',
    seats: [
      { playerId: ME, displayName: '自分' },
      { playerId: 'p-2', displayName: '相手' },
    ],
  });
  const cards = [
    instance('mon', pokemonFid),
    ...energyFids.map((fid, i) => instance(`e-${i}`, fid)),
  ];
  const actions: Action[] = [
    { type: 'placePokemon', playerId: ME, slotId: 'active', cardId: 'mon', actorId: ME, at: 1 },
    ...energyFids.map((_, i) => ({
      type: 'attachCard' as const,
      playerId: ME,
      slotId: 'active' as const,
      cardId: `e-${i}`,
      as: 'energy' as const,
      actorId: ME,
      at: 2 + i,
    })),
  ];
  return applyActions(withCards(base, cards), actions, { cards: index });
}

const view = (state: GameState) => slotViewOf(state, index, ME, 'active');

describe('★エネルギーの粒は「何個ぶん」で描く', () => {
  it('基本エネルギー1枚は粒1つ', () => {
    expect(view(board(BASIC.functionalId, [WATER.functionalId])).energy).toEqual(['water']);
  });

  it('★ダブル無色エネルギー1枚は粒2つ', () => {
    const slot = view(board(BASIC.functionalId, [DOUBLE.functionalId]));
    expect(slot.slot?.attachedEnergy).toHaveLength(1);
    expect(slot.energy).toEqual(['colorless', 'colorless']);
  });

  it('★はたらいていないエネルギーは粒0（ツインエネルギー × ルールを持つポケモン）', () => {
    const slot = view(board(RULE_MON.functionalId, [TWIN.functionalId]));
    expect(slot.slot?.attachedEnergy).toHaveLength(1);
    expect(slot.energy).toEqual([]);
    // ★「ついているのに0個」の理由が読める
    expect(slot.energyTitle).toContain('0個ぶん');
    expect(slot.energyTitle).toContain('ルールを持つポケモンにはたらかない');
  });

  it('内訳は枚数と個数の両方を出す', () => {
    const slot = view(board(BASIC.functionalId, [DOUBLE.functionalId, WATER.functionalId]));
    expect(slot.energy).toHaveLength(3);
    expect(slot.energyTitle).toContain('3個ぶん');
    expect(slot.energyTitle).toContain('2枚');
  });

  it('何もついていなければ内訳は空', () => {
    expect(view(board(BASIC.functionalId, [])).energyTitle).toBe('');
  });
});
