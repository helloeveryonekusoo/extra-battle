/** T29: 「状況が変化しないなら使えない」と、ワザだけの例外を確認する。 */
import { describe, expect, it } from 'vitest';
import { applyAction, type Action } from './actions';
import { canApply, checkUsability } from './applicability';
import { buildCardIndex } from './cards';
import type { EffectSource, Op } from './dsl';
import { createExecution, stepEffect } from './interpreter';
import { WARNING_CODES, type RuleContext } from './rules';
import { ALICE, BOB, tick } from './testFixtures';
import { createGameState, withCards } from './gameState';
import type { CardInstance, CardText, GameState, PokemonInPlay } from './types';

const BASIC: CardText = {
  functionalId: 'fn-basic',
  name: 'テストポケモン',
  supertype: 'pokemon',
  hp: 100,
  stage: 'basic',
  types: ['colorless'],
  ruleBox: null,
  attacks: [{ name: 'なかまをよぶ', cost: [], damage: '', text: '山札からたねポケモンを出す。' }],
  abilities: [{ name: 'てあて', text: '回復する。', kind: 'ability' }],
  weakness: null,
  resistance: null,
  retreatCost: 1,
};

const HEAL_ITEM: CardText = {
  functionalId: 'fn-heal-item',
  name: '回復グッズ',
  supertype: 'trainer',
  trainerKind: 'item',
  text: 'ダメカンを3個とる。',
};

const ctx: RuleContext = { cards: buildCardIndex([BASIC, HEAL_ITEM]) };

const slot = (slotId: PokemonInPlay['slotId'], instanceId: string, damageCounters = 0): PokemonInPlay => ({
  slotId,
  stack: [instanceId],
  attachedEnergy: [],
  attachedTool: null,
  damageCounters,
  conditions: [],
  placedOnTurn: 0,
  evolvedOnTurn: null,
  devolvedOnTurn: null,
  grantedAttacks: [],
  notes: '',
});

function table(damageCounters = 0, benchCount = 0): GameState {
  const base = createGameState({
    gameId: 'g-applicability',
    rngSeed: 'seed',
    seats: [
      { playerId: ALICE, displayName: 'アリス' },
      { playerId: BOB, displayName: 'ボブ' },
    ],
  });
  const cards: CardInstance[] = [
    {
      instanceId: 'active-card',
      functionalId: BASIC.functionalId,
      ownerId: ALICE,
      zone: 'active',
      visibleTo: [ALICE, BOB],
      faceUp: true,
    },
    {
      instanceId: 'heal-item',
      functionalId: HEAL_ITEM.functionalId,
      ownerId: ALICE,
      zone: 'hand',
      visibleTo: [ALICE],
      faceUp: false,
    },
    {
      instanceId: 'deck-basic',
      functionalId: BASIC.functionalId,
      ownerId: ALICE,
      zone: 'deck',
      visibleTo: [],
      faceUp: false,
      position: 0,
    },
  ];

  const bench = Array.from({ length: benchCount }, (_, index) => {
    const instanceId = `bench-card-${index}`;
    cards.push({
      instanceId,
      functionalId: BASIC.functionalId,
      ownerId: ALICE,
      zone: 'bench',
      visibleTo: [ALICE, BOB],
      faceUp: true,
    });
    return slot(`bench-${index}`, instanceId);
  });

  const state = withCards({ ...base, phase: 'turn', turn: 3, setup: null }, cards);
  state.players[ALICE]!.pokemon = [slot('active', 'active-card', damageCounters), ...bench];
  return state;
}

const itemSource: EffectSource = {
  instanceId: 'heal-item',
  playerId: ALICE,
  label: HEAL_ITEM.name,
};

const attackSource: EffectSource = {
  instanceId: 'active-card',
  playerId: ALICE,
  label: 'なかまをよぶ',
  attackIndex: 0,
};

const abilitySource: EffectSource = {
  instanceId: 'active-card',
  playerId: ALICE,
  label: 'てあて',
  abilityIndex: 0,
};

const healOps: Op[] = [
  {
    op: 'heal',
    target: {
      kind: 'choose',
      player: 'self',
      chooser: 'self',
      filter: { hasDamage: true },
    },
    amount: 30,
  },
];

const start = (ops: Op[], source: EffectSource): Action => ({
  type: 'startEffect',
  executionId: 'e-applicability',
  ops,
  source,
  actorId: ALICE,
  at: tick(),
});

describe('状況が変化しない効果のdry-run', () => {
  it('ダメカンがなければ回復グッズと特性は使えない', () => {
    expect(canApply(table(), healOps, itemSource, ctx)).toBe(false);
    expect(checkUsability(table(), 'item', healOps, itemSource, ctx).usable).toBe(false);
    expect(checkUsability(table(), 'ability', healOps, abilitySource, ctx).usable).toBe(false);
  });

  it('回復できるポケモンがいれば使える', () => {
    const verdict = checkUsability(table(3), 'item', healOps, itemSource, ctx);
    expect(verdict.usable).toBe(true);
    expect(verdict.dryRun.changes).toBe(true);
  });

  it('判定不能なmanualは使える側に倒す', () => {
    expect(canApply(table(), [{ op: 'manual', prompt: '手で処理する' }], itemSource, ctx)).toBe(
      true,
    );
  });
});

describe('ワザとトレーナーズ・特性の差', () => {
  it('何も起きないワザでも宣言できる', () => {
    const verdict = checkUsability(table(), 'attack', healOps, attackSource, ctx);
    expect(verdict.usable).toBe(true);
    expect(verdict.dryRun.changes).toBe(false);
    expect(verdict.reason).toContain('ワザは宣言できます');
  });

  it('使えないトレーナーズは警告するが、効果開始は止めない', () => {
    const state = applyAction(table(), start(healOps, itemSource), ctx);
    expect(state.execution).not.toBeNull();
    expect(state.log.at(-1)?.warnings[0]?.code).toBe(WARNING_CODES.EFFECT_NO_CHANGE);
  });

  it('何も起きないワザには「状況が変わらない」警告を出さない', () => {
    const state = applyAction(table(), start(healOps, attackSource), ctx);
    expect(state.execution).not.toBeNull();
    expect(state.log.at(-1)?.warnings).toEqual([]);
  });
});

describe('ベンチ満杯のワザ', () => {
  const searchToBench: Op[] = [
    {
      op: 'search',
      from: 'deck',
      owner: 'self',
      filter: { supertype: ['pokemon'], stage: ['basic'] },
      count: 1,
      upTo: false,
      dest: 'bench',
      destSlot: { kind: 'bench', player: 'self' },
      chooser: 'self',
      reveal: true,
      thenShuffle: true,
    },
  ];

  it('宣言できるが、山札を公開せずに終わる', () => {
    const state = table(0, 5);
    state.execution = createExecution({
      executionId: 'e-full-bench',
      ops: searchToBench,
      source: attackSource,
    });

    const after = stepEffect(state, {}, ctx);
    expect(checkUsability(state, 'attack', searchToBench, attackSource, ctx).usable).toBe(true);
    expect(after.execution).toBeNull();
    expect(after.cards['deck-basic']?.visibleTo).toEqual([]);
  });
});
