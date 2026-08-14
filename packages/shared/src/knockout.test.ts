import { describe, expect, it } from 'vitest';
import { applyActions, type Action } from './actions';
import { buildCardIndex } from './cards';
import {
  findKnockoutCandidates,
  isKnockedOut,
  knockoutTimingOf,
  prizesForRuleBox,
  remainingHpOf,
} from './knockout';
import { findSlot } from './gameState';
import { ALICE, BOB, makeTable, tick } from './testFixtures';
import type { CardText, RuleBox } from './types';

const act = <T extends Omit<Action, 'actorId' | 'at'>>(action: T): Action =>
  ({ ...action, actorId: ALICE, at: tick() }) as Action;

const pokemon = (
  functionalId: string,
  name: string,
  hp: number,
  ruleBox: RuleBox = null,
): CardText => ({ functionalId, name, supertype: 'pokemon', hp, ruleBox });

const cardIndex = buildCardIndex([
  pokemon('smpl-card-0', 'テストたね', 100),
  pokemon('smpl-card-3', 'テストVMAX', 330, 'VMAX'),
]);
const ctx = { cards: cardIndex };

describe('きぜつ候補の検出', () => {
  it('damageCounters × 10 がHP以上になった瞬間に候補を作る', () => {
    const state = applyActions(makeTable(), [
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-deck-0' }),
      act({ type: 'setDamage', playerId: ALICE, slotId: 'active', counters: 10 }),
    ]);
    const slot = findSlot(state, ALICE, 'active')!;

    expect(remainingHpOf(state, ctx, slot)).toBe(0);
    expect(isKnockedOut(state, ctx, slot)).toBe(true);
    expect(findKnockoutCandidates(state, ctx)).toEqual([
      expect.objectContaining({
        playerId: ALICE,
        slotId: 'active',
        pokemonName: 'テストたね',
        currentHp: 100,
        damage: 100,
        remainingHp: 0,
        suggestedPrizeCount: 1,
        prizeTo: BOB,
      }),
    ]);
  });

  it('HP未満と、カード定義がなくHP不明のポケモンは候補にしない', () => {
    const under = applyActions(makeTable(), [
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-deck-0' }),
      act({ type: 'setDamage', playerId: ALICE, slotId: 'active', counters: 9 }),
    ]);
    expect(findKnockoutCandidates(under, ctx)).toEqual([]);

    const unknown = applyActions(makeTable(), [
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-deck-9' }),
      act({ type: 'setDamage', playerId: ALICE, slotId: 'active', counters: 99 }),
    ]);
    expect(findKnockoutCandidates(unknown, ctx)).toEqual([]);
  });

  it('進化スタック最上段のHP・ルールボックスと、ついている全カードを参照する', () => {
    const state = applyActions(makeTable(), [
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-deck-0' }),
      act({ type: 'evolvePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-deck-3' }),
      act({
        type: 'attachCard',
        playerId: ALICE,
        slotId: 'active',
        cardId: 'a-deck-1',
        as: 'energy',
      }),
      act({
        type: 'attachCard',
        playerId: ALICE,
        slotId: 'active',
        cardId: 'a-deck-2',
        as: 'tool',
      }),
      act({ type: 'setDamage', playerId: ALICE, slotId: 'active', counters: 34 }),
    ]);

    expect(findKnockoutCandidates(state, ctx)[0]).toEqual(
      expect.objectContaining({
        topInstanceId: 'a-deck-3',
        pokemonName: 'テストVMAX',
        currentHp: 330,
        damage: 340,
        suggestedPrizeCount: 3,
        stackSize: 2,
        attachedCount: 2,
      }),
    );
  });
});

describe('きぜつ時の既定サイド枚数', () => {
  it('非ルール=1、EX系=2、VMAX/TAGTEAM/VUNION=3', () => {
    expect(prizesForRuleBox(null)).toBe(1);
    for (const box of ['EX', 'MEGA', 'GX', 'V', 'VSTAR', 'ex'] as const) {
      expect(prizesForRuleBox(box)).toBe(2);
    }
    for (const box of ['VMAX', 'TAGTEAM', 'VUNION'] as const) {
      expect(prizesForRuleBox(box)).toBe(3);
    }
    for (const box of ['BREAK', 'PRISM', 'RADIANT'] as const) {
      expect(prizesForRuleBox(box)).toBe(1);
    }
  });
});

describe('きぜつ検出タイミング', () => {
  it('ワザ後・ポケモンチェック中・チェック完了直後を区別する', () => {
    const afterAttack = applyActions(makeTable(), [
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-deck-0' }),
      act({ type: 'useAttack', playerId: ALICE, slotId: 'active', attackName: 'テストワザ' }),
      act({ type: 'setDamage', playerId: ALICE, slotId: 'active', counters: 10 }),
    ]);
    expect(knockoutTimingOf(afterAttack)).toBe('afterAttack');

    const checking = applyActions(afterAttack, [
      act({ type: 'setPhase', phase: 'pokemonCheck' }),
    ]);
    expect(knockoutTimingOf(checking)).toBe('pokemonCheck');

    const completed = applyActions(checking, [act({ type: 'endTurn' })]);
    expect(knockoutTimingOf(completed)).toBe('pokemonCheck');
  });
});
