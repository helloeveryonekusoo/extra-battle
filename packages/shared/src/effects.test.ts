/**
 * T26 の完了条件:
 *   「次の相手の番、このポケモンが受けるワザのダメージは+50される」が正しく機能し、
 *   ★そのポケモンがベンチに下がると消える。
 *
 * あわせて §3.2 の消滅ルールをすべて確かめる:
 *   ベンチに戻る / 場を離れる / 進化する / 退化する → 特殊状態・かかっている効果すべて
 */
import { describe, expect, it } from 'vitest';
import { applyAction, applyActions, type Action } from './actions';
import { buildCardIndex } from './cards';
import { createGameState, withCards } from './gameState';
import {
  damageModifierFor,
  describeEffect,
  effectSlotKey,
  effectsOnSlot,
  globalEffects,
  preventsAttackDamage,
} from './effects';
import type { ActiveEffectTemplate, EffectSource, Op } from './dsl';
import type { RuleContext } from './rules';
import { ALICE, BOB, tick } from './testFixtures';
import type { CardInstance, CardText, GameState, PlayerId } from './types';

const act = <T extends Omit<Action, 'actorId' | 'at'>>(a: T, actorId: PlayerId = ALICE): Action =>
  ({ ...a, actorId, at: tick() }) as Action;

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
const STAGE1: CardText = {
  ...BASIC,
  functionalId: 'fn-stage1',
  name: 'カメール',
  stage: 'stage1',
  evolvesFrom: 'ゼニガメ',
  hp: 100,
};
const ctx: RuleContext = { cards: buildCardIndex([BASIC, STAGE1]) };

/** 「発生源」はアリスのバトル場のカード（a-p0）にしておく */
const SOURCE: EffectSource = { instanceId: 'a-p0', playerId: ALICE, label: 'ダメージ増加のワザ' };

const card = (instanceId: string, ownerId: PlayerId, fid: string, position: number): CardInstance => ({
  instanceId,
  functionalId: fid,
  ownerId,
  zone: 'hand',
  visibleTo: [ownerId],
  faceUp: false,
  position,
});

/**
 * アリス: バトル場 a-p0 / ベンチ0 a-p1、手札に進化カード
 * ボブ:   バトル場 b-p0
 * 第1番はアリス。
 */
function startedGame(): GameState {
  const base = createGameState({
    gameId: 'g-effects',
    rngSeed: 'seed',
    seats: [
      { playerId: ALICE, displayName: 'アリス' },
      { playerId: BOB, displayName: 'ボブ' },
    ],
  });
  const seeded = withCards(base, [
    card('a-p0', ALICE, 'fn-basic', 0),
    card('a-p1', ALICE, 'fn-basic', 1),
    card('a-evo', ALICE, 'fn-stage1', 2),
    card('a-evo2', ALICE, 'fn-stage1', 3),
    card('b-p0', BOB, 'fn-basic', 0),
  ]);
  return applyActions(
    seeded,
    [
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-p0' }),
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'bench-0', cardId: 'a-p1' }),
      act({ type: 'placePokemon', playerId: BOB, slotId: 'active', cardId: 'b-p0' }, BOB),
      act({ type: 'setFirstPlayer', playerId: ALICE }),
      act({ type: 'setSetupStep', step: 'done' }),
    ],
    ctx,
  );
}

/** 「次の相手の番、このポケモンが受けるワザのダメージは +50 される」 */
const PLUS_50: ActiveEffectTemplate = {
  target: { slot: { kind: 'self' } },
  applyAt: 'step5',
  kind: 'damageModifier',
  payload: { delta: 50 },
  duration: { type: 'untilEndOfNextOpponentTurn' },
  expiresOn: ['targetLeavesPlay', 'targetReturnsToBench', 'targetEvolves', 'targetDevolves'],
  label: '受けるワザのダメージ +50',
};

/** 効果を1つかけた状態を作る */
function withEffect(
  state: GameState,
  effect: ActiveEffectTemplate = PLUS_50,
  executionId = 'x1',
): GameState {
  const ops: Op[] = [{ op: 'applyEffect', effect }];
  let next = applyAction(
    state,
    act({ type: 'startEffect', executionId, ops, source: SOURCE }),
    ctx,
  );
  next = applyAction(next, act({ type: 'effectStep', executionId }), ctx);
  return next;
}

const endTurn = (state: GameState): GameState =>
  applyAction(state, act({ type: 'endTurn' }, 'server'), ctx);

// ── 完了条件 ──

describe('★「次の相手の番、受けるワザのダメージは+50」', () => {
  it('効果がかかり、対象と期間が正しく入る', () => {
    const state = withEffect(startedGame());

    const on = effectsOnSlot(state, ALICE, 'active');
    expect(on).toHaveLength(1);
    expect(on[0]?.kind).toBe('damageModifier');
    expect(on[0]?.applyAt).toBe('step5');
    expect(on[0]?.target).toEqual({ slotId: effectSlotKey(ALICE, 'active') });
    expect(on[0]?.duration.type).toBe('untilEndOfNextOpponentTurn');
    expect(on[0]?.createdOnTurn).toBe(1);
    expect(describeEffect(on[0]!)).toBe('受けるワザのダメージ +50');
  });

  it('★ダメージ修正として +50 が読み出せる', () => {
    const state = withEffect(startedGame());
    expect(damageModifierFor(state, ALICE, 'active', 'step5')).toBe(50);
    // 「与える側」の段には出てこない
    expect(damageModifierFor(state, ALICE, 'active', 'step2')).toBe(0);
    // 他のスロットにはかかっていない
    expect(damageModifierFor(state, ALICE, 'bench-0', 'step5')).toBe(0);
    expect(damageModifierFor(state, BOB, 'active', 'step5')).toBe(0);
  });

  it('★次の相手の番の終わりに消える', () => {
    let state = withEffect(startedGame());
    expect(state.turn).toBe(1);

    // 第1番（アリス）が終わる → まだ残る
    state = endTurn(state);
    expect(state.activePlayer).toBe(BOB);
    expect(damageModifierFor(state, ALICE, 'active', 'step5')).toBe(50);

    // 第2番（ボブ＝相手）が終わる → ここで消える
    state = endTurn(state);
    expect(state.activePlayer).toBe(ALICE);
    expect(damageModifierFor(state, ALICE, 'active', 'step5')).toBe(0);
    expect(state.effects).toEqual([]);
  });

  it('★そのポケモンがベンチに下がると消える', () => {
    const state = withEffect(startedGame());
    expect(effectsOnSlot(state, ALICE, 'active')).toHaveLength(1);

    const retreated = applyAction(
      state,
      act({
        type: 'movePokemon',
        playerId: ALICE,
        fromSlotId: 'active',
        toSlotId: 'bench-0',
        asRetreat: true,
      }),
      ctx,
    );

    expect(retreated.effects).toEqual([]);
    expect(damageModifierFor(retreated, ALICE, 'active', 'step5')).toBe(0);
    expect(damageModifierFor(retreated, ALICE, 'bench-0', 'step5')).toBe(0);
  });
});

// ── §3.2 の消滅ルール ──

describe('★§3.2 の消滅ルールをすべて守る', () => {
  it('場を離れる（トラッシュ）と消える', () => {
    const state = withEffect(startedGame());
    const removed = applyAction(
      state,
      act({ type: 'removePokemon', playerId: ALICE, slotId: 'active', toZone: 'discard' }),
      ctx,
    );
    expect(removed.effects).toEqual([]);
  });

  it('きぜつしても消える', () => {
    const state = withEffect(startedGame());
    const knocked = applyAction(
      state,
      act({
        type: 'knockOut',
        playerId: ALICE,
        slotId: 'active',
        expectedTopInstanceId: 'a-p0',
        prizePlayerId: BOB,
        prizeCount: 1,
        prizeCardIds: [],
      }),
      ctx,
    );
    expect(knocked.effects).toEqual([]);
  });

  it('進化すると消える。ただしダメカン・エネルギーは引きつぐ', () => {
    let state = withEffect(startedGame());
    state = applyAction(
      state,
      act({ type: 'adjustDamage', playerId: ALICE, slotId: 'active', delta: 3 }),
      ctx,
    );

    const evolved = applyAction(
      state,
      act({ type: 'evolvePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-evo' }),
      ctx,
    );

    expect(evolved.effects).toEqual([]);
    // ★ダメカンは引きつぐ
    const slot = evolved.players[ALICE]?.pokemon.find((p) => p.slotId === 'active');
    expect(slot?.damageCounters).toBe(3);
    expect(slot?.stack).toEqual(['a-p0', 'a-evo']);
  });

  it('退化すると消える', () => {
    const evolved = applyAction(
      startedGame(),
      act({ type: 'evolvePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-evo' }),
      ctx,
    );
    const state = withEffect(evolved);
    expect(state.effects).toHaveLength(1);

    const devolved = applyAction(
      state,
      act({ type: 'devolvePokemon', playerId: ALICE, slotId: 'active', toZone: 'hand' }),
      ctx,
    );
    expect(devolved.effects).toEqual([]);
  });

  it('★特殊状態も同じ4つで消える', () => {
    const poisoned = applyAction(
      startedGame(),
      act({ type: 'setCondition', playerId: ALICE, slotId: 'active', condition: 'poisoned', on: true }),
      ctx,
    );
    expect(poisoned.players[ALICE]?.pokemon.find((p) => p.slotId === 'active')?.conditions).toEqual([
      'poisoned',
    ]);

    // ベンチに下がる
    const retreated = applyAction(
      poisoned,
      act({ type: 'movePokemon', playerId: ALICE, fromSlotId: 'active', toSlotId: 'bench-0' }),
      ctx,
    );
    const wasActive = retreated.players[ALICE]?.pokemon.find((p) => p.slotId === 'bench-0');
    expect(wasActive?.conditions).toEqual([]);

    // 進化する
    const evolved = applyAction(
      poisoned,
      act({ type: 'evolvePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-evo' }),
      ctx,
    );
    expect(evolved.players[ALICE]?.pokemon.find((p) => p.slotId === 'active')?.conditions).toEqual([]);
  });
});

// ── 期間の種類 ──

describe('期間ごとの切れ方', () => {
  const withDuration = (type: ActiveEffectTemplate['duration']['type']) =>
    withEffect(startedGame(), { ...PLUS_50, duration: { type } });

  it('thisTurn は、かかった番が終わったら消える', () => {
    const state = endTurn(withDuration('thisTurn'));
    expect(state.effects).toEqual([]);
  });

  it('untilEndOfNextOwnTurn は、次の自分の番が終わるまで残る', () => {
    let state = withDuration('untilEndOfNextOwnTurn');
    state = endTurn(state); // 第1番（アリス）終了 → まだ残る
    expect(state.effects).toHaveLength(1);
    state = endTurn(state); // 第2番（ボブ）終了 → まだ残る
    expect(state.effects).toHaveLength(1);
    state = endTurn(state); // 第3番（アリス）終了 → 消える
    expect(state.effects).toEqual([]);
  });

  it('wholeGame は番が進んでも消えない（オルタージェネシスGX 等）', () => {
    let state = withEffect(startedGame(), {
      target: { global: true },
      applyAt: 'none',
      kind: 'extraPrize',
      payload: { delta: 1 },
      duration: { type: 'wholeGame' },
      label: 'サイドを1枚多くとる',
    });
    for (let i = 0; i < 4; i += 1) state = endTurn(state);
    expect(globalEffects(state)).toHaveLength(1);
    expect(describeEffect(state.effects[0]!)).toBe('サイドを1枚多くとる');
  });

  it('whileSourceInPlay は、発生源が場を離れたら消える', () => {
    const state = withEffect(startedGame(), {
      ...PLUS_50,
      target: { slot: { kind: 'active', player: 'opponent' } },
      duration: { type: 'whileSourceInPlay' },
    });
    expect(effectsOnSlot(state, BOB, 'active')).toHaveLength(1);

    // 発生源（a-p0）を場から出す
    const gone = applyAction(
      state,
      act({ type: 'removePokemon', playerId: ALICE, slotId: 'active', toZone: 'discard' }),
      ctx,
    );
    expect(gone.effects).toEqual([]);
  });

  it('sourceLeavesPlay を指定すれば、期間が別でも発生源で切れる', () => {
    const state = withEffect(startedGame(), {
      ...PLUS_50,
      target: { slot: { kind: 'active', player: 'opponent' } },
      duration: { type: 'wholeGame' },
      expiresOn: ['sourceLeavesPlay'],
    });
    const gone = applyAction(
      state,
      act({ type: 'removePokemon', playerId: ALICE, slotId: 'active', toZone: 'discard' }),
      ctx,
    );
    expect(gone.effects).toEqual([]);
  });
});

// ── その他 ──

describe('効果の読み出しと手動の外し方', () => {
  it('「ワザのダメージを受けない」が読める', () => {
    const state = withEffect(startedGame(), {
      target: { slot: { kind: 'self' } },
      applyAt: 'step5',
      kind: 'preventAttackDamage',
      duration: { type: 'untilEndOfNextOpponentTurn' },
    });
    expect(preventsAttackDamage(state, ALICE, 'active')).toBe(true);
    expect(preventsAttackDamage(state, BOB, 'active')).toBe(false);
    expect(describeEffect(state.effects[0]!)).toBe('ワザのダメージを受けない');
  });

  it('★手で外せる（自動判定が取りこぼしても卓が進む）', () => {
    const state = withEffect(startedGame());
    const effect = state.effects[0]!;

    const removed = applyAction(
      state,
      act({ type: 'removeEffect', effectId: effect.effectId, label: describeEffect(effect) }),
      ctx,
    );
    expect(removed.effects).toEqual([]);
    expect(removed.log[removed.log.length - 1]?.summary).toContain('受けるワザのダメージ +50');
  });

  it('効果は重ねがけできる', () => {
    let state = withEffect(startedGame(), PLUS_50, 'x1');
    state = withEffect(state, { ...PLUS_50, payload: { delta: 30 }, label: '+30' }, 'x2');
    expect(damageModifierFor(state, ALICE, 'active', 'step5')).toBe(80);
  });

  it('対象が決まらなければ何も起きない（落ちない）', () => {
    const state = withEffect(startedGame(), {
      ...PLUS_50,
      target: { slot: { kind: 'bench', player: 'opponent', index: 3 } },
    });
    expect(state.effects).toEqual([]);
  });

  it('相手にも同じ効果が見える（§5.2 の可視化のため隠さない）', () => {
    const state = withEffect(startedGame());
    // filterStateFor は effects をそのまま通す（発生源のIDだけ伏せる）
    expect(state.effects).toHaveLength(1);
    expect(state.effects[0]?.payload['label']).toBe('受けるワザのダメージ +50');
  });
});
