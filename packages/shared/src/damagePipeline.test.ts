/**
 * T28 の完了条件:
 *   ★6段それぞれの単体テストと、複数効果が重なる結合テストが通る。
 *
 *   Step1: 基本ダメージ → 0以下なら終了
 *   Step2: 与える側にかかっている効果 → 0以下なら終了
 *   Step3: 弱点
 *   Step4: 抵抗力 → 0以下なら終了
 *   Step5: 受ける側にかかっている効果 → 0以下なら終了
 *   Step6: 確定。「ワザのダメージを受けない」ならここで0
 */
import { describe, expect, it } from 'vitest';
import { applyAction, applyActions, type Action } from './actions';
import { buildCardIndex } from './cards';
import {
  damageInputFromState,
  runDamagePipeline,
  type DamagePipelineInput,
  type DamageStepId,
} from './damageCalculation';
import { createGameState, findSlot, withCards } from './gameState';
import type { ActiveEffectTemplate, EffectSource, Op } from './dsl';
import type { RuleContext } from './rules';
import { ALICE, BOB, tick } from './testFixtures';
import type { CardInstance, CardText, GameState, PlayerId } from './types';

const act = <T extends Omit<Action, 'actorId' | 'at'>>(a: T, actorId: PlayerId = ALICE): Action =>
  ({ ...a, actorId, at: tick() }) as Action;

/** 水弱点×2 / 炎抵抗-20 のポケモン */
const DEFENDER = {
  weakness: { type: 'water' as const, modifier: '×2' },
  resistance: { type: 'fire' as const, modifier: '-20' },
};

const base = (over: Partial<DamagePipelineInput> = {}): DamagePipelineInput => ({
  baseDamage: 100,
  attackerTypes: ['water'],
  defender: DEFENDER,
  targetIsBench: false,
  ...over,
});

const run = (over: Partial<DamagePipelineInput> = {}) => runDamagePipeline(base(over));
const valueAt = (result: ReturnType<typeof run>, step: DamageStepId) =>
  result.steps.find((s) => s.step === step)?.value;
const detailAt = (result: ReturnType<typeof run>, step: DamageStepId) =>
  result.steps.find((s) => s.step === step)?.detail;

// ── Step1 ──────────────────────────────

describe('Step1: 基本ダメージ', () => {
  it('人が確定させた値がそのまま入る', () => {
    const result = run({ attackerTypes: ['grass'] });
    expect(valueAt(result, 1)).toBe(100);
  });

  it('★「120+」の + は Step1 に織り込む（Step2 の「+●●される」とは別物）', () => {
    // ワザ本文が +30 なら、人が 150 を確定させて渡す。Step2 の効果は別に足す
    const printed = run({ baseDamage: 150, attackerTypes: ['grass'], attackerModifier: 30 });
    expect(valueAt(printed, 1)).toBe(150);
    expect(valueAt(printed, 2)).toBe(180);
    expect(detailAt(printed, 2)).toBe('+30');
  });

  it('★0以下ならそこで終了する', () => {
    const result = run({ baseDamage: 0, attackerModifier: 999 });
    expect(result.stoppedAt).toBe(1);
    expect(result.finalDamage).toBe(0);
    // 以降の段は「打ち切り」として並ぶ
    expect(detailAt(result, 2)).toBe('（0以下で打ち切り）');
  });

  it('端数と負値は切り捨てて0以上にする', () => {
    expect(run({ baseDamage: -50, attackerTypes: ['grass'] }).finalDamage).toBe(0);
    expect(valueAt(run({ baseDamage: 30.7, attackerTypes: ['grass'] }), 1)).toBe(30);
  });
});

// ── Step2 ──────────────────────────────

describe('Step2: 与える側にかかっている効果', () => {
  it('与える側の効果を足す', () => {
    const result = run({ attackerTypes: ['grass'], attackerModifier: 30 });
    expect(valueAt(result, 2)).toBe(130);
    expect(result.finalDamage).toBe(130);
  });

  it('マイナスの効果も足せる', () => {
    const result = run({ attackerTypes: ['grass'], attackerModifier: -40 });
    expect(valueAt(result, 2)).toBe(60);
    expect(detailAt(result, 2)).toBe('−40');
  });

  it('★0以下ならそこで終了する（弱点も見ない）', () => {
    const result = run({ attackerModifier: -100 });
    expect(result.stoppedAt).toBe(2);
    expect(result.finalDamage).toBe(0);
    // 弱点で2倍にはならない
    expect(detailAt(result, 3)).toBe('（0以下で打ち切り）');
  });

  it('効いた効果の名前が残る（§5.3 で追える）', () => {
    const result = run({
      attackerTypes: ['grass'],
      attackerModifier: 30,
      attackerModifierSources: ['与えるダメージ +30'],
    });
    expect(result.steps.find((s) => s.step === 2)?.sources).toEqual(['与えるダメージ +30']);
  });
});

// ── Step3 ──────────────────────────────

describe('Step3: 弱点', () => {
  it('タイプが一致すれば ×2 になる', () => {
    const result = run();
    expect(valueAt(result, 3)).toBe(200);
    expect(detailAt(result, 3)).toBe('×2');
  });

  it('タイプが違えば何も起きない', () => {
    expect(valueAt(run({ attackerTypes: ['grass'] }), 3)).toBe(100);
  });

  it('デュアルタイプはどちらか一致すれば当たる', () => {
    expect(valueAt(run({ attackerTypes: ['grass', 'water'] }), 3)).toBe(200);
  });

  it('「+30」表記の弱点（旧カード）も読める', () => {
    const result = run({ defender: { weakness: { type: 'water', modifier: '+30' }, resistance: null } });
    expect(valueAt(result, 3)).toBe(130);
  });

  it('★「弱点・抵抗力を計算しない」ならとばす', () => {
    const result = run({ skipWeaknessResistance: true });
    expect(valueAt(result, 3)).toBe(100);
    expect(detailAt(result, 3)).toBe('計算しない');
    expect(detailAt(result, 4)).toBe('計算しない');
  });

  it('★ベンチは既定で計算しない。明示すれば計算する', () => {
    expect(valueAt(run({ targetIsBench: true }), 3)).toBe(100);
    expect(valueAt(run({ targetIsBench: true, applyWeaknessToBench: true }), 3)).toBe(200);
  });

  it('★弱点の増減効果は「かかっている効果」ではないので、Step5 の無視では消えない', () => {
    const result = run({ weaknessDelta: 30, ignoreTargetEffects: true, targetModifier: -50 });
    // 弱点 ×2 のあと +30
    expect(valueAt(result, 3)).toBe(230);
    // 受ける側の効果 -50 は無視される
    expect(detailAt(result, 5)).toBe('計算しない');
    expect(result.finalDamage).toBe(230);
  });
});

// ── Step4 ──────────────────────────────

describe('Step4: 抵抗力', () => {
  it('タイプが一致すれば引く', () => {
    const result = run({ attackerTypes: ['fire'] });
    expect(valueAt(result, 4)).toBe(80);
    expect(detailAt(result, 4)).toBe('−20');
  });

  it('タイプが違えば何も起きない', () => {
    expect(valueAt(run({ attackerTypes: ['grass'] }), 4)).toBe(100);
  });

  it('★0以下ならそこで終了する', () => {
    const result = run({ baseDamage: 20, attackerTypes: ['fire'] });
    expect(result.stoppedAt).toBe(4);
    expect(result.finalDamage).toBe(0);
  });

  it('抵抗力の増減効果も Step4 で入る', () => {
    const result = run({ attackerTypes: ['fire'], resistanceDelta: -10 });
    expect(valueAt(result, 4)).toBe(70);
  });
});

// ── Step5 ──────────────────────────────

describe('Step5: 受ける側にかかっている効果', () => {
  it('受ける側の効果を足す', () => {
    const result = run({ attackerTypes: ['grass'], targetModifier: 50 });
    expect(valueAt(result, 5)).toBe(150);
  });

  it('軽減もできる', () => {
    const result = run({ attackerTypes: ['grass'], targetModifier: -30 });
    expect(valueAt(result, 5)).toBe(70);
  });

  it('★0以下ならそこで終了する', () => {
    const result = run({ attackerTypes: ['grass'], targetModifier: -100 });
    expect(result.stoppedAt).toBe(5);
    expect(result.finalDamage).toBe(0);
  });

  it('★「かかっている効果を計算しない」なら丸ごととばす', () => {
    const result = run({ attackerTypes: ['grass'], targetModifier: -100, ignoreTargetEffects: true });
    expect(result.finalDamage).toBe(100);
  });

  it('手動調整は人の指定なので、効果を無視するワザでも残る', () => {
    const result = run({
      attackerTypes: ['grass'],
      targetModifier: -100,
      ignoreTargetEffects: true,
      manualAdjustment: -20,
    });
    expect(result.finalDamage).toBe(80);
    expect(result.steps.find((s) => s.step === 5)?.sources).toEqual(['手動調整 −20']);
  });
});

// ── Step6 ──────────────────────────────

describe('Step6: 確定', () => {
  it('最終値が確定する', () => {
    const result = run({ attackerTypes: ['grass'] });
    expect(valueAt(result, 6)).toBe(100);
    expect(result.finalDamage).toBe(100);
    expect(result.damageCounters).toBe(10);
  });

  it('★「ワザのダメージを受けない」ならここで0になる', () => {
    const result = run({ targetPreventsDamage: true });
    // Step5 までは 200 のまま進んで、最後に0になる
    expect(valueAt(result, 5)).toBe(200);
    expect(result.finalDamage).toBe(0);
    expect(detailAt(result, 6)).toBe('ワザのダメージを受けない');
  });

  it('★「かかっている効果を計算しない」なら「受けない」も無視する', () => {
    const result = run({ targetPreventsDamage: true, ignoreTargetEffects: true });
    expect(result.finalDamage).toBe(200);
  });
});

// ── 結合 ──────────────────────────────

describe('★複数効果が重なる結合テスト', () => {
  it('指示書 §5.3 の例（基本120 → +30 → ×2 → 抵抗なし → -30 → 270）', () => {
    const result = runDamagePipeline({
      baseDamage: 120,
      attackerTypes: ['lightning'],
      defender: { weakness: { type: 'lightning', modifier: '×2' }, resistance: null },
      targetIsBench: false,
      attackerModifier: 30,
      targetModifier: -30,
    });

    expect(result.steps.map((s) => [s.label, s.detail, s.value])).toEqual([
      ['基本ダメージ', '120', 120],
      ['与える側の効果', '+30', 150],
      ['弱点 lightning', '×2', 300],
      ['抵抗力', '—', 300],
      ['受ける側の効果', '−30', 270],
      ['確定', '270', 270],
    ]);
    expect(result.finalDamage).toBe(270);
    expect(result.damageCounters).toBe(27);
  });

  it('段の順番が入れ替わらない（弱点は Step2 のあと、Step5 の前）', () => {
    // Step2 で +50 → 弱点 ×2 なので (100+50)*2 = 300。順番が逆なら 100*2+50 = 250
    const result = run({ attackerModifier: 50 });
    expect(result.finalDamage).toBe(300);
  });

  it('与える側と受ける側の効果は別の段に入る', () => {
    // (100 + 50) * 2 - 30 = 270
    const result = run({ attackerModifier: 50, targetModifier: -30 });
    expect(valueAt(result, 2)).toBe(150);
    expect(valueAt(result, 3)).toBe(300);
    expect(valueAt(result, 5)).toBe(270);
  });

  it('弱点・抵抗力・両側の効果・軽減がすべて重なる', () => {
    // 基本80 +20 = 100 → 弱点×2 = 200 → 抵抗-20 = 180 → 受ける側 -60 = 120
    const result = runDamagePipeline({
      baseDamage: 80,
      attackerTypes: ['water', 'fire'],
      defender: DEFENDER,
      targetIsBench: false,
      attackerModifier: 20,
      targetModifier: -60,
    });
    expect(result.finalDamage).toBe(120);
    expect(result.stoppedAt).toBeNull();
  });

  it('打ち切りが起きると、それ以降の効果は一切効かない', () => {
    // Step2 で 0 になれば、弱点×2 も受ける側の +100 も効かない
    const result = run({ attackerModifier: -100, targetModifier: 100 });
    expect(result.finalDamage).toBe(0);
    expect(result.stoppedAt).toBe(2);
  });
});

// ── 盤面との接続（T26 の効果を読む） ──

const MON: CardText = {
  functionalId: 'fn-mon',
  name: 'ゼニガメ',
  supertype: 'pokemon',
  hp: 200,
  types: ['water'],
  stage: 'basic',
  ruleBox: null,
  attacks: [],
  weakness: { type: 'lightning', modifier: '×2' },
  resistance: null,
  retreatCost: 1,
};
const ctx: RuleContext = { cards: buildCardIndex([MON]) };

function board(): GameState {
  const seeded = withCards(
    createGameState({
      gameId: 'g-dmg',
      rngSeed: 'seed',
      seats: [
        { playerId: ALICE, displayName: 'アリス' },
        { playerId: BOB, displayName: 'ボブ' },
      ],
    }),
    (['a-p0', 'b-p0'] as const).map((instanceId, i) => ({
      instanceId,
      functionalId: 'fn-mon',
      ownerId: i === 0 ? ALICE : BOB,
      zone: 'hand',
      visibleTo: [i === 0 ? ALICE : BOB],
      faceUp: false,
      position: 0,
    })) as CardInstance[],
  );
  return applyActions(
    seeded,
    [
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-p0' }),
      act({ type: 'placePokemon', playerId: BOB, slotId: 'active', cardId: 'b-p0' }, BOB),
      act({ type: 'setFirstPlayer', playerId: ALICE }),
      act({ type: 'setSetupStep', step: 'done' }),
    ],
    ctx,
  );
}

function withEffect(state: GameState, effect: ActiveEffectTemplate, id: string): GameState {
  const ops: Op[] = [{ op: 'applyEffect', effect }];
  const source: EffectSource = { instanceId: 'a-p0', playerId: ALICE, label: 'テストのワザ' };
  let next = applyAction(state, act({ type: 'startEffect', executionId: id, ops, source }), ctx);
  return applyAction(next, act({ type: 'effectStep', executionId: id }), ctx);
}

describe('★盤面にかかっている効果が正しい段に入る', () => {
  const attacker = { playerId: ALICE, slotId: 'active' as const };
  const target = { playerId: BOB, slotId: 'active' as const };

  it('applyAt: step2 は与える側の段に入る', () => {
    const state = withEffect(
      board(),
      {
        target: { slot: { kind: 'self' } },
        applyAt: 'step2',
        kind: 'damageModifier',
        payload: { delta: 30 },
        duration: { type: 'thisTurn' },
        label: '与えるダメージ +30',
      },
      'x1',
    );

    const input = damageInputFromState(state, ctx, attacker, target, {
      baseDamage: 100,
      attackerTypes: ['water'],
      defender: { weakness: null, resistance: null },
      targetIsBench: false,
    });
    expect(input.attackerModifier).toBe(30);
    expect(input.targetModifier).toBe(0);
    expect(input.attackerModifierSources).toEqual(['与えるダメージ +30']);
    expect(runDamagePipeline(input).finalDamage).toBe(130);
  });

  it('applyAt: step5 は受ける側の段に入る', () => {
    const state = withEffect(
      board(),
      {
        target: { slot: { kind: 'active', player: 'opponent' } },
        applyAt: 'step5',
        kind: 'damageModifier',
        payload: { delta: 50 },
        duration: { type: 'untilEndOfNextOpponentTurn' },
        label: '受けるワザのダメージ +50',
      },
      'x2',
    );

    const input = damageInputFromState(state, ctx, attacker, target, {
      baseDamage: 100,
      attackerTypes: ['water'],
      defender: { weakness: null, resistance: null },
      targetIsBench: false,
    });
    expect(input.attackerModifier).toBe(0);
    expect(input.targetModifier).toBe(50);
    expect(runDamagePipeline(input).finalDamage).toBe(150);
  });

  it('「ワザのダメージを受けない」が盤面から読める', () => {
    const state = withEffect(
      board(),
      {
        target: { slot: { kind: 'active', player: 'opponent' } },
        applyAt: 'step5',
        kind: 'preventAttackDamage',
        duration: { type: 'untilEndOfNextOpponentTurn' },
      },
      'x3',
    );
    const input = damageInputFromState(state, ctx, attacker, target, {
      baseDamage: 100,
      attackerTypes: ['water'],
      defender: { weakness: null, resistance: null },
      targetIsBench: false,
    });
    expect(input.targetPreventsDamage).toBe(true);
    expect(runDamagePipeline(input).finalDamage).toBe(0);
  });
});

// ── ★ダメカンはダメージではない ──

describe('★ダメカンを「のせる」のはダメージではない（§4.1 の注意）', () => {
  it('弱点があってもダメカンは2倍にならない', () => {
    // ボブのポケモンは 雷弱点×2。ダメカンを3個のせても 3個のまま
    const ops: Op[] = [
      {
        op: 'damageCounter',
        action: 'place',
        count: 3,
        target: { kind: 'active', player: 'opponent' },
        distribution: 'single',
      },
    ];
    const source: EffectSource = { instanceId: 'a-p0', playerId: ALICE, label: 'ダメカンをのせるワザ' };
    let state = applyAction(
      board(),
      act({ type: 'startEffect', executionId: 'dc', ops, source }),
      ctx,
    );
    state = applyAction(state, act({ type: 'effectStep', executionId: 'dc' }), ctx);

    expect(findSlot(state, BOB, 'active')?.damageCounters).toBe(3);
  });

  it('軽減効果がかかっていてもダメカンは減らない', () => {
    let state = withEffect(
      board(),
      {
        target: { slot: { kind: 'active', player: 'opponent' } },
        applyAt: 'step5',
        kind: 'damageModifier',
        payload: { delta: -100 },
        duration: { type: 'thisTurn' },
        label: '受けるワザのダメージ −100',
      },
      'x4',
    );

    const ops: Op[] = [
      {
        op: 'damageCounter',
        action: 'place',
        count: 5,
        target: { kind: 'active', player: 'opponent' },
        distribution: 'single',
      },
    ];
    const source: EffectSource = { instanceId: 'a-p0', playerId: ALICE, label: 'ダメカンをのせるワザ' };
    state = applyAction(state, act({ type: 'startEffect', executionId: 'dc2', ops, source }), ctx);
    state = applyAction(state, act({ type: 'effectStep', executionId: 'dc2' }), ctx);

    // ★軽減を一切通さない
    expect(findSlot(state, BOB, 'active')?.damageCounters).toBe(5);
  });

  it('取り除くこともできる', () => {
    let state = board();
    state = applyAction(
      state,
      act({ type: 'setDamage', playerId: BOB, slotId: 'active', counters: 8 }),
      ctx,
    );
    const ops: Op[] = [
      {
        op: 'damageCounter',
        action: 'remove',
        count: 3,
        target: { kind: 'active', player: 'opponent' },
        distribution: 'single',
      },
    ];
    const source: EffectSource = { instanceId: 'a-p0', playerId: ALICE, label: 'ダメカン除去' };
    state = applyAction(state, act({ type: 'startEffect', executionId: 'dc3', ops, source }), ctx);
    state = applyAction(state, act({ type: 'effectStep', executionId: 'dc3' }), ctx);
    expect(findSlot(state, BOB, 'active')?.damageCounters).toBe(5);
  });
});
