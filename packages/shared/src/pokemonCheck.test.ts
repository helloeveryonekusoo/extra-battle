import { describe, expect, it } from 'vitest';
import { applyAction, applyActions, type Action } from './actions';
import { findSlot } from './gameState';
import { isPokemonCheckComplete, nextPokemonCheckTarget } from './pokemonCheck';
import { ALICE, BOB, makeTable, tick } from './testFixtures';

const act = <T extends Omit<Action, 'actorId' | 'at'>>(action: T): Action =>
  ({ ...action, actorId: 'server', at: tick() }) as Action;

function checkingTable() {
  return applyActions(makeTable(), [
    act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-deck-0' }),
    act({ type: 'placePokemon', playerId: ALICE, slotId: 'bench-0', cardId: 'a-deck-1' }),
    act({ type: 'placePokemon', playerId: BOB, slotId: 'active', cardId: 'b-deck-0' }),
    act({ type: 'setCondition', playerId: ALICE, slotId: 'active', condition: 'poisoned', on: true }),
    act({ type: 'setCondition', playerId: ALICE, slotId: 'active', condition: 'burned', on: true }),
    act({ type: 'setCondition', playerId: ALICE, slotId: 'active', condition: 'paralyzed', on: true }),
    act({ type: 'setCondition', playerId: BOB, slotId: 'active', condition: 'poisoned', on: true }),
    act({ type: 'setCondition', playerId: BOB, slotId: 'active', condition: 'burned', on: true }),
    act({ type: 'setCondition', playerId: BOB, slotId: 'active', condition: 'asleep', on: true }),
    // ベンチの特殊状態は機能しないため、列挙されないことも確認する。
    act({ type: 'setCondition', playerId: ALICE, slotId: 'bench-0', condition: 'asleep', on: true }),
    act({ type: 'setPhase', phase: 'pokemonCheck' }),
  ]);
}

describe('ポケモンチェックの対象列挙', () => {
  it('どく→やけど→ねむり→マヒの4段を作り、バトル場だけを対象にする', () => {
    const state = checkingTable();
    expect(state.phase).toBe('pokemonCheck');
    expect(state.pokemonCheck?.endedTurnPlayerId).toBe(ALICE);
    expect(state.pokemonCheck?.steps.map((step) => [step.order, step.condition])).toEqual([
      [1, 'poisoned'],
      [2, 'burned'],
      [3, 'asleep'],
      [4, 'paralyzed'],
    ]);
    expect(state.pokemonCheck?.steps[0]?.targets.map((target) => target.playerId)).toEqual([
      ALICE,
      BOB,
    ]);
    expect(state.pokemonCheck?.steps[2]?.targets).toEqual([
      expect.objectContaining({ playerId: BOB, slotId: 'active' }),
    ]);
    // マヒは直前に番を行ったプレイヤーだけが回復対象。
    expect(state.pokemonCheck?.steps[3]?.targets).toEqual([
      expect.objectContaining({ playerId: ALICE, slotId: 'active' }),
    ]);
    expect(
      state.pokemonCheck?.steps.flatMap((step) => step.targets).some((target) => target.slotId === 'bench-0'),
    ).toBe(false);
  });

  it('同じフェーズを再送しても解決状態を初期化しない', () => {
    const state = checkingTable();
    const target = nextPokemonCheckTarget(state)!.target;
    const resolved = applyAction(
      state,
      act({
        type: 'resolvePokemonCheckTarget',
        order: 1,
        playerId: target.playerId,
        slotId: target.slotId,
        expectedTopInstanceId: target.topInstanceId,
        poisonCounters: 1,
      }),
    );
    const repeated = applyAction(resolved, act({ type: 'setPhase', phase: 'pokemonCheck' }));
    expect(repeated.pokemonCheck?.steps[0]?.targets[0]?.resolved).toBe(true);
  });
});

describe('ポケモンチェックの実処理', () => {
  it('どくのダメカン数を変更できる', () => {
    const state = checkingTable();
    const target = nextPokemonCheckTarget(state)!.target;
    const before = findSlot(state, target.playerId, target.slotId)!.damageCounters;
    const next = applyAction(
      state,
      act({
        type: 'resolvePokemonCheckTarget',
        order: 1,
        playerId: target.playerId,
        slotId: target.slotId,
        expectedTopInstanceId: target.topInstanceId,
        poisonCounters: 3,
      }),
    );
    expect(findSlot(next, target.playerId, target.slotId)?.damageCounters).toBe(before + 3);
    expect(next.pokemonCheck?.steps[0]?.targets[0]?.resolved).toBe(true);
  });

  it('やけどは+2してオモテなら回復、ウラなら残る', () => {
    const base = checkingTable();
    // 先にどく2件を解決して、やけどへ進める。
    const afterPoison = (base.pokemonCheck?.steps[0]?.targets ?? []).reduce(
      (state, target) =>
        applyAction(
          state,
          act({
            type: 'resolvePokemonCheckTarget',
            order: 1,
            playerId: target.playerId,
            slotId: target.slotId,
            expectedTopInstanceId: target.topInstanceId,
            poisonCounters: 1,
          }),
        ),
      base,
    );
    const [aliceTarget, bobTarget] = afterPoison.pokemonCheck!.steps[1]!.targets;
    const heads = applyAction(
      afterPoison,
      act({
        type: 'resolvePokemonCheckTarget',
        order: 2,
        playerId: aliceTarget!.playerId,
        slotId: aliceTarget!.slotId,
        expectedTopInstanceId: aliceTarget!.topInstanceId,
        coinResult: 'heads',
      }),
    );
    expect(findSlot(heads, ALICE, 'active')?.damageCounters).toBe(3); // どく1 + やけど2
    expect(findSlot(heads, ALICE, 'active')?.conditions).not.toContain('burned');

    const tails = applyAction(
      heads,
      act({
        type: 'resolvePokemonCheckTarget',
        order: 2,
        playerId: bobTarget!.playerId,
        slotId: bobTarget!.slotId,
        expectedTopInstanceId: bobTarget!.topInstanceId,
        coinResult: 'tails',
      }),
    );
    expect(findSlot(tails, BOB, 'active')?.damageCounters).toBe(3);
    expect(findSlot(tails, BOB, 'active')?.conditions).toContain('burned');
    expect(tails.pokemonCheck?.steps[1]?.targets[1]?.coinResult).toBe('tails');
  });

  it('ねむりはオモテで回復し、マヒは持ち主の番の終わりに回復する', () => {
    let state = checkingTable();
    for (const step of state.pokemonCheck!.steps.slice(0, 2)) {
      for (const target of step.targets) {
        state = applyAction(
          state,
          act({
            type: 'resolvePokemonCheckTarget',
            order: step.order,
            playerId: target.playerId,
            slotId: target.slotId,
            expectedTopInstanceId: target.topInstanceId,
            ...(step.order === 1 ? { poisonCounters: 1 } : { coinResult: 'tails' as const }),
          }),
        );
      }
    }
    const asleep = nextPokemonCheckTarget(state)!;
    state = applyAction(
      state,
      act({
        type: 'resolvePokemonCheckTarget',
        order: 3,
        playerId: asleep.target.playerId,
        slotId: asleep.target.slotId,
        expectedTopInstanceId: asleep.target.topInstanceId,
        coinResult: 'heads',
      }),
    );
    expect(findSlot(state, BOB, 'active')?.conditions).not.toContain('asleep');

    const paralyzed = nextPokemonCheckTarget(state)!;
    state = applyAction(
      state,
      act({
        type: 'resolvePokemonCheckTarget',
        order: 4,
        playerId: paralyzed.target.playerId,
        slotId: paralyzed.target.slotId,
        expectedTopInstanceId: paralyzed.target.topInstanceId,
      }),
    );
    expect(findSlot(state, ALICE, 'active')?.conditions).not.toContain('paralyzed');
    expect(isPokemonCheckComplete(state)).toBe(true);
  });

  it('スキップは盤面を変えずに次へ進め、未処理のまま番を終えると警告して通す', () => {
    const base = checkingTable();
    const target = nextPokemonCheckTarget(base)!.target;
    const skipped = applyAction(
      base,
      act({
        type: 'resolvePokemonCheckTarget',
        order: 1,
        playerId: target.playerId,
        slotId: target.slotId,
        expectedTopInstanceId: target.topInstanceId,
        skip: true,
      }),
    );
    expect(findSlot(skipped, target.playerId, target.slotId)?.damageCounters).toBe(0);
    expect(skipped.pokemonCheck?.steps[0]?.targets[0]?.skipped).toBe(true);

    const ended = applyAction(skipped, act({ type: 'endTurn' }));
    expect(ended.phase).toBe('turn');
    expect(ended.pokemonCheck).toBeNull();
    expect(ended.log.at(-1)?.warnings.map((warning) => warning.code)).toContain(
      'POKEMON_CHECK_INCOMPLETE',
    );
  });
});
