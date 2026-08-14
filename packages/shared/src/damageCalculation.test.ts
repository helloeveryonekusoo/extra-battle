import { describe, expect, it } from 'vitest';
import { applyAction, type Action } from './actions';
import { calculateDamage, suggestedBaseDamage } from './damageCalculation';
import { createGameState } from './gameState';
import type { CardText, PokemonInPlay } from './types';

const defender: Pick<CardText, 'weakness' | 'resistance'> = {
  weakness: { type: 'water', modifier: '×2' },
  resistance: { type: 'fire', modifier: '-20' },
};

const input = {
  baseDamage: 100,
  attackerTypes: ['fire', 'water'] as const,
  defender,
  targetIsBench: false,
  applyToBench: false,
  useWeakness: true,
  useResistance: true,
  manualAdjustment: 30,
};

describe('T19 ダメージ計算', () => {
  it('デュアルタイプの弱点と抵抗力を順に提案し、最後に手動調整する', () => {
    const result = calculateDamage(input);
    expect(result.weaknessApplied).toBe(true);
    expect(result.afterWeakness).toBe(200);
    expect(result.resistanceApplied).toBe(true);
    expect(result.afterResistance).toBe(180);
    expect(result.finalDamage).toBe(210);
  });

  it('弱点・抵抗力は個別に無効化できる', () => {
    expect(calculateDamage({ ...input, useWeakness: false }).finalDamage).toBe(110);
    expect(calculateDamage({ ...input, useResistance: false }).finalDamage).toBe(230);
  });

  it('ベンチは既定で弱点・抵抗力を計算せず、明示時だけ計算する', () => {
    const bench = { ...input, targetIsBench: true };
    expect(calculateDamage(bench).finalDamage).toBe(130);
    expect(calculateDamage({ ...bench, applyToBench: true }).finalDamage).toBe(210);
  });

  it('可変表記は数値候補だけ取り出し、効果分を自動計算しない', () => {
    expect(suggestedBaseDamage('120+')).toBe(120);
    expect(suggestedBaseDamage('60×')).toBe(60);
    expect(suggestedBaseDamage('')).toBe(0);
  });

  it('確定Actionは対象が同じときだけダメカンを加える', () => {
    const state = createGameState({
      gameId: 'damage-action',
      rngSeed: 'seed',
      seats: [{ playerId: 'p1', displayName: 'P1' }],
    });
    const slot: PokemonInPlay = {
      slotId: 'active',
      stack: ['target'],
      attachedEnergy: [],
      attachedTool: null,
      damageCounters: 2,
      conditions: [],
      placedOnTurn: 0,
      evolvedOnTurn: null,
      devolvedOnTurn: null,
      grantedAttacks: [],
      notes: '',
    };
    state.players.p1!.pokemon = [slot];
    const makeAction = (expectedTopInstanceId: string): Action => ({
      type: 'applyDamageCalculation',
      playerId: 'p1',
      slotId: 'active',
      expectedTopInstanceId,
      attackName: 'テストワザ',
      baseDamage: 100,
      weaknessApplied: true,
      resistanceApplied: false,
      manualAdjustment: 0,
      finalDamage: 200,
      damageCounters: 20,
      actorId: 'p1',
      at: 1,
    });
    expect(applyAction(state, makeAction('target')).players.p1?.pokemon[0]?.damageCounters).toBe(22);
    expect(applyAction(state, makeAction('old-target')).players.p1?.pokemon[0]?.damageCounters).toBe(2);
  });
});
