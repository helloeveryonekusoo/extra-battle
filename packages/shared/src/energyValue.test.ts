/**
 * T33 の肝: 特殊エネルギーが「何個ぶんはたらくか」を **固定値にしない**。
 *
 * ここで確かめるのは、同じ1枚のカードでも
 *   - つけている相手（ドラゴンか / 進化か / ルールを持つか）
 *   - 場に出ているスタジアム（シンオウ神殿）
 * が変われば、答えが変わること。
 *
 * あわせて T33 のどうぐ・スタジアムの常時効果（にげる・ダメージ・弱点）も確かめる。
 */
import { describe, expect, it } from 'vitest';
import { applyAction, applyActions, type Action } from './actions';
import { buildCardIndex } from './cards';
import { createGameState, withCards } from './gameState';
import {
  canPayCost,
  continuousDamageModifier,
  energyCountOn,
  energyOnSlot,
  energyValueOf,
  getRetreatCost,
  ignoresWeakness,
  specialEnergyNullified,
} from './derived';
import { damageInputFromState, runDamagePipeline } from './damageCalculation';
import type { RuleContext } from './rules';
import { ALICE, BOB, tick } from './testFixtures';
import type { CardInstance, CardText, GameState, PlayerId } from './types';

const act = <T extends Omit<Action, 'actorId' | 'at'>>(a: T, actorId: PlayerId = ALICE): Action =>
  ({ ...a, actorId, at: tick() }) as Action;

// ── カード定義（data/cards/t33.json と同じ形） ──

const mon = (over: Partial<CardText> & Pick<CardText, 'functionalId' | 'name'>): CardText => ({
  supertype: 'pokemon',
  hp: 100,
  types: ['water'],
  stage: 'basic',
  ruleBox: null,
  attacks: [],
  weakness: null,
  resistance: null,
  retreatCost: 2,
  ...over,
});

const PLAIN = mon({ functionalId: 'fn-plain', name: 'ゼニガメ' });
const RULE_MON = mon({ functionalId: 'fn-v', name: 'ゼニガメV', ruleBox: 'V', hp: 190 });
const EX_MON = mon({ functionalId: 'fn-ex', name: 'カメックスEX', ruleBox: 'EX', hp: 180 });
const EVOLVED = mon({
  functionalId: 'fn-stage1',
  name: 'カメール',
  stage: 'stage1',
  evolvesFrom: 'ゼニガメ',
});
const DRAGON = mon({ functionalId: 'fn-dragon', name: 'ミニリュウ', types: ['dragon'] });
const FIGHTER = mon({
  functionalId: 'fn-fighter',
  name: 'イワーク',
  types: ['fighting'],
  weakness: { type: 'water', modifier: '×2' },
});

const WATER_ENERGY: CardText = {
  functionalId: 'fn-water-energy',
  name: '基本水エネルギー',
  supertype: 'energy',
  isBasicEnergy: true,
  energyProvides: ['water'],
};

const energy = (over: Partial<CardText> & Pick<CardText, 'functionalId' | 'name'>): CardText => ({
  supertype: 'energy',
  isBasicEnergy: false,
  energyProvides: ['colorless'],
  text: 'テスト用',
  ...over,
});

const DOUBLE_COLORLESS = energy({
  functionalId: 'fn-dce',
  name: 'ダブル無色エネルギー',
  energyValue: [{ provides: ['colorless'], amount: 2, label: '無色2個ぶん' }],
});

const TWIN = energy({
  functionalId: 'fn-twin',
  name: 'ツインエネルギー',
  energyValue: [
    { when: { ruleBox: 'any' }, provides: [], amount: 0, label: 'ルールを持つポケモンにはたらかない' },
    { provides: ['colorless'], amount: 2, label: '無色2個ぶん' },
  ],
});

const TRIPLE = energy({
  functionalId: 'fn-triple',
  name: 'トリプル加速エネルギー',
  energyValue: [{ when: { stage: ['stage1', 'stage2'] }, provides: ['colorless'], amount: 3 }],
});

const DOUBLE_DRAGON = energy({
  functionalId: 'fn-ddragon',
  name: 'ダブルドラゴンエネルギー',
  energyValue: [{ when: { types: ['dragon'] }, provides: 'any', amount: 2 }],
});

const RAINBOW = energy({
  functionalId: 'fn-rainbow',
  name: 'レインボーエネルギー',
  energyValue: [{ provides: 'any', amount: 1 }],
});

const STRONG = energy({
  functionalId: 'fn-strong',
  name: 'ストロングエネルギー',
  energyProvides: ['fighting'],
  energyValue: [{ when: { types: ['fighting'] }, provides: ['fighting'], amount: 1 }],
  continuous: [
    {
      kind: 'damageModifier',
      scope: 'self',
      applyAt: 'step2',
      delta: 20,
      on: 'attached',
      selfFilter: { types: ['fighting'] },
      label: 'ストロングエネルギー ワザのダメージ +20',
    },
  ],
});

const DOUBLE_TURBO = energy({
  functionalId: 'fn-turbo',
  name: 'ダブルターボエネルギー',
  energyValue: [{ provides: ['colorless'], amount: 2 }],
  continuous: [
    {
      kind: 'damageModifier',
      scope: 'self',
      applyAt: 'step2',
      delta: -20,
      on: 'attached',
      label: 'ダブルターボエネルギー ワザのダメージ −20',
    },
  ],
});

const WEAKNESS_GUARD = energy({
  functionalId: 'fn-weakguard',
  name: 'ウィークガードエネルギー',
  energyValue: [{ provides: ['colorless'], amount: 1 }],
  continuous: [{ kind: 'ignoreWeakness', scope: 'self', on: 'attached' }],
});

const tool = (over: Partial<CardText> & Pick<CardText, 'functionalId' | 'name'>): CardText => ({
  supertype: 'trainer',
  trainerKind: 'tool',
  text: 'テスト用',
  ...over,
});

const FLOAT_STONE = tool({
  functionalId: 'fn-float',
  name: 'ふうせん',
  continuous: [{ kind: 'retreatCost', scope: 'self', delta: -2, on: 'attached' }],
});

const LIGHT_STONE = tool({
  functionalId: 'fn-light',
  name: 'かるいし',
  continuous: [{ kind: 'retreatCost', scope: 'self', delta: -99, on: 'attached' }],
});

const MUSCLE_BAND = tool({
  functionalId: 'fn-muscle',
  name: 'ちからのハチマキ',
  continuous: [
    {
      kind: 'damageModifier',
      scope: 'self',
      applyAt: 'step2',
      delta: 20,
      on: 'attached',
      where: 'active',
      label: 'ちからのハチマキ ワザのダメージ +20',
    },
  ],
});

const EXPERT_BELT = tool({
  functionalId: 'fn-belt',
  name: 'たつじんのおび',
  continuous: [
    {
      kind: 'damageModifier',
      scope: 'self',
      applyAt: 'step2',
      delta: 30,
      on: 'attached',
      defenderFilter: { ruleBox: ['EX'] },
      label: 'たつじんのおび ポケモンEXに +30',
    },
  ],
});

const SHINNOU: CardText = {
  functionalId: 'fn-shinnou',
  name: 'シンオウ神殿',
  supertype: 'trainer',
  trainerKind: 'stadium',
  text: '特殊エネルギーは無色1個ぶんになる。',
  continuous: [{ kind: 'nullifySpecialEnergy', scope: 'all' }],
};

const POOL = [
  PLAIN, RULE_MON, EX_MON, EVOLVED, DRAGON, FIGHTER,
  WATER_ENERGY, DOUBLE_COLORLESS, TWIN, TRIPLE, DOUBLE_DRAGON, RAINBOW,
  STRONG, DOUBLE_TURBO, WEAKNESS_GUARD,
  FLOAT_STONE, LIGHT_STONE, MUSCLE_BAND, EXPERT_BELT, SHINNOU,
];

const ctx: RuleContext = { cards: buildCardIndex(POOL) };

// ── 卓の用意 ────────────────────────

let seq = 0;
const instance = (functionalId: string, ownerId: PlayerId): CardInstance => ({
  instanceId: `${ownerId}-${functionalId}-${(seq += 1)}`,
  functionalId,
  ownerId,
  zone: 'hand',
  visibleTo: [ownerId],
  faceUp: false,
  position: seq,
});

interface Board {
  state: GameState;
  ids: Record<string, string>;
}

/**
 * アリスのバトル場に mon、ボブのバトル場に PLAIN を置き、
 * attach のカードをアリスのバトル場につける。
 */
function board(
  activeFid: string,
  attach: readonly { fid: string; as: 'energy' | 'tool' }[] = [],
  options: {
    stadium?: string;
    benchFid?: string;
    opponentFid?: string;
    /** ベンチのポケモンにつけるカード */
    benchAttach?: readonly { fid: string; as: 'energy' | 'tool' }[];
  } = {},
): Board {
  const base = createGameState({
    gameId: 'g-energy',
    rngSeed: 'seed',
    seats: [
      { playerId: ALICE, displayName: 'アリス' },
      { playerId: BOB, displayName: 'ボブ' },
    ],
  });

  const ids: Record<string, string> = {};
  const cards: CardInstance[] = [];
  const add = (fid: string, owner: PlayerId, key: string): string => {
    const created = instance(fid, owner);
    cards.push(created);
    ids[key] = created.instanceId;
    return created.instanceId;
  };

  add(activeFid, ALICE, 'active');
  add(options.opponentFid ?? PLAIN.functionalId, BOB, 'opponent');
  if (options.benchFid) add(options.benchFid, ALICE, 'bench');
  if (options.stadium) add(options.stadium, ALICE, 'stadium');
  attach.forEach((entry, i) => add(entry.fid, ALICE, `attach-${i}`));
  (options.benchAttach ?? []).forEach((entry, i) => add(entry.fid, ALICE, `bench-attach-${i}`));

  const actions: Action[] = [
    act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: ids['active']! }),
    act({ type: 'placePokemon', playerId: BOB, slotId: 'active', cardId: ids['opponent']! }, BOB),
  ];
  if (options.benchFid) {
    actions.push(
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'bench-0', cardId: ids['bench']! }),
    );
  }
  if (options.stadium) {
    actions.push(act({ type: 'setStadium', cardId: ids['stadium']! }));
  }
  attach.forEach((entry, i) => {
    actions.push(
      act({
        type: 'attachCard',
        playerId: ALICE,
        slotId: 'active',
        cardId: ids[`attach-${i}`]!,
        as: entry.as,
      }),
    );
  });
  (options.benchAttach ?? []).forEach((entry, i) => {
    actions.push(
      act({
        type: 'attachCard',
        playerId: ALICE,
        slotId: 'bench-0',
        cardId: ids[`bench-attach-${i}`]!,
        as: entry.as,
      }),
    );
  });

  return { state: applyActions(withCards(base, cards), actions, ctx), ids };
}

const attachEnergy = (fid: string) => ({ fid, as: 'energy' as const });
const attachTool = (fid: string) => ({ fid, as: 'tool' as const });

const valueOn = (b: Board, key = 'attach-0') => {
  const slot = b.state.players[ALICE]!.pokemon.find((s) => s.slotId === 'active');
  return energyValueOf(b.state, b.ids[key]!, slot, ALICE, ctx);
};

// ── ★何個ぶんはたらくか ────────────────

describe('★特殊エネルギーは「何個ぶん」を毎回計算する', () => {
  it('基本エネルギーは書かれたタイプで1個ぶん', () => {
    const b = board(PLAIN.functionalId, [attachEnergy(WATER_ENERGY.functionalId)]);
    expect(valueOn(b)).toMatchObject({ types: ['water'], amount: 1 });
  });

  it('ダブル無色エネルギーは相手を問わず無色2個ぶん', () => {
    const b = board(RULE_MON.functionalId, [attachEnergy(DOUBLE_COLORLESS.functionalId)]);
    expect(valueOn(b)).toMatchObject({ types: ['colorless'], amount: 2 });
  });

  it('★ツインエネルギー: ルールを持たないなら2個ぶん', () => {
    const b = board(PLAIN.functionalId, [attachEnergy(TWIN.functionalId)]);
    expect(valueOn(b).amount).toBe(2);
  });

  it('★ツインエネルギー: ルールを持つポケモンでは0個ぶん（はたらかない）', () => {
    const b = board(RULE_MON.functionalId, [attachEnergy(TWIN.functionalId)]);
    expect(valueOn(b)).toMatchObject({ amount: 0, label: 'ルールを持つポケモンにはたらかない' });
  });

  it('★トリプル加速エネルギー: たねでは0個ぶん、進化なら3個ぶん', () => {
    expect(valueOn(board(PLAIN.functionalId, [attachEnergy(TRIPLE.functionalId)])).amount).toBe(0);
    expect(valueOn(board(EVOLVED.functionalId, [attachEnergy(TRIPLE.functionalId)])).amount).toBe(3);
  });

  it('★ダブルドラゴンエネルギー: ドラゴンなら好きなタイプ2個ぶん、そうでなければ0', () => {
    const onDragon = valueOn(board(DRAGON.functionalId, [attachEnergy(DOUBLE_DRAGON.functionalId)]));
    expect(onDragon).toMatchObject({ types: 'any', amount: 2 });
    expect(valueOn(board(PLAIN.functionalId, [attachEnergy(DOUBLE_DRAGON.functionalId)])).amount).toBe(0);
  });

  it('★同じ1枚でも、進化させれば答えが変わる（状態に書き込んでいない証拠）', () => {
    const b = board(PLAIN.functionalId, [attachEnergy(TRIPLE.functionalId)]);
    expect(valueOn(b).amount).toBe(0);

    // ゼニガメ → カメール に進化させる。エネルギーは引きつぐ
    const evolveId = instance(EVOLVED.functionalId, ALICE).instanceId;
    const withCard = {
      ...b.state,
      cards: {
        ...b.state.cards,
        [evolveId]: {
          instanceId: evolveId,
          functionalId: EVOLVED.functionalId,
          ownerId: ALICE,
          zone: 'hand' as const,
          visibleTo: [ALICE],
          faceUp: false,
        },
      },
    };
    const evolved = applyAction(
      withCard,
      act({ type: 'evolvePokemon', playerId: ALICE, slotId: 'active', cardId: evolveId }),
      ctx,
    );
    expect(valueOn({ ...b, state: evolved }).amount).toBe(3);
  });

  it('ついているエネルギーの合計は「枚数」ではなく「個数」', () => {
    const b = board(PLAIN.functionalId, [
      attachEnergy(DOUBLE_COLORLESS.functionalId),
      attachEnergy(WATER_ENERGY.functionalId),
    ]);
    expect(b.state.players[ALICE]!.pokemon[0]!.attachedEnergy).toHaveLength(2);
    expect(energyCountOn(b.state, ALICE, 'active', ctx)).toBe(3);
  });
});

// ── ★シンオウ神殿 ─────────────────────

describe('★シンオウ神殿を出すと特殊エネルギーのはたらきが消え、片づけると戻る', () => {
  it('出ている間はどの特殊エネルギーも無色1個ぶん', () => {
    const b = board(DRAGON.functionalId, [attachEnergy(DOUBLE_DRAGON.functionalId)], {
      stadium: SHINNOU.functionalId,
    });
    expect(specialEnergyNullified(b.state, ALICE, ctx)).toBe(true);
    expect(valueOn(b)).toMatchObject({ types: ['colorless'], amount: 1 });
  });

  it('★片づければ元の2個ぶんに戻る（解除処理を書いていない）', () => {
    const b = board(DRAGON.functionalId, [attachEnergy(DOUBLE_DRAGON.functionalId)], {
      stadium: SHINNOU.functionalId,
    });
    const removed = applyAction(b.state, act({ type: 'setStadium', cardId: null }), ctx);
    expect(specialEnergyNullified(removed, ALICE, ctx)).toBe(false);
    expect(valueOn({ ...b, state: removed })).toMatchObject({ types: 'any', amount: 2 });
  });

  it('基本エネルギーは影響を受けない', () => {
    const b = board(PLAIN.functionalId, [attachEnergy(WATER_ENERGY.functionalId)], {
      stadium: SHINNOU.functionalId,
    });
    expect(valueOn(b)).toMatchObject({ types: ['water'], amount: 1 });
  });
});

// ── コストが払えるか ─────────────────

describe('canPayCost', () => {
  const values = (b: Board) => energyOnSlot(b.state, ALICE, 'active', ctx);

  it('ダブル無色エネルギー1枚で無色2個のコストを払える', () => {
    const b = board(PLAIN.functionalId, [attachEnergy(DOUBLE_COLORLESS.functionalId)]);
    expect(canPayCost(['colorless', 'colorless'], values(b))).toBe(true);
    expect(canPayCost(['water', 'colorless'], values(b))).toBe(false);
  });

  it('レインボーエネルギーは好きな色として使える', () => {
    const b = board(PLAIN.functionalId, [attachEnergy(RAINBOW.functionalId)]);
    expect(canPayCost(['fire'], values(b))).toBe(true);
  });

  it('★色つきを先に割り当てる（無色に回して足りなくならない）', () => {
    const b = board(PLAIN.functionalId, [
      attachEnergy(RAINBOW.functionalId),
      attachEnergy(WATER_ENERGY.functionalId),
    ]);
    // 水1 + 無色1 → レインボーを無色に回しても成立する
    expect(canPayCost(['water', 'colorless'], values(b))).toBe(true);
    // 水2 → レインボーを水に回して成立する
    expect(canPayCost(['water', 'water'], values(b))).toBe(true);
    // 水3 は足りない
    expect(canPayCost(['water', 'water', 'water'], values(b))).toBe(false);
  });

  it('はたらいていないエネルギーは1個も数えない', () => {
    const b = board(RULE_MON.functionalId, [attachEnergy(TWIN.functionalId)]);
    expect(canPayCost(['colorless'], values(b))).toBe(false);
  });
});

// ── にげるためのエネルギー ────────────

describe('getRetreatCost', () => {
  it('何もついていなければカードの値', () => {
    const b = board(PLAIN.functionalId);
    expect(getRetreatCost(b.state, ALICE, 'active', ctx)).toBe(2);
  });

  it('ふうせんで2個ぶん少なくなる', () => {
    const b = board(PLAIN.functionalId, [attachTool(FLOAT_STONE.functionalId)]);
    expect(getRetreatCost(b.state, ALICE, 'active', ctx)).toBe(0);
  });

  it('★0未満にはならない', () => {
    const b = board(PLAIN.functionalId, [attachTool(LIGHT_STONE.functionalId)]);
    expect(getRetreatCost(b.state, ALICE, 'active', ctx)).toBe(0);
  });

  it('★どうぐは、つけているポケモンにだけ効く', () => {
    const b = board(PLAIN.functionalId, [attachTool(FLOAT_STONE.functionalId)], {
      benchFid: PLAIN.functionalId,
    });
    expect(getRetreatCost(b.state, ALICE, 'active', ctx)).toBe(0);
    expect(getRetreatCost(b.state, ALICE, 'bench-0', ctx)).toBe(2);
  });
});

// ── どうぐ・エネルギーのダメージ増減 ────

describe('場のカードが出すダメージ増減（T28 の Step2 / Step5 に合流する）', () => {
  const modifier = (b: Board, target: 'active' = 'active') =>
    continuousDamageModifier(
      b.state,
      { playerId: ALICE, slotId: 'active' },
      { playerId: BOB, slotId: target },
      'step2',
      ctx,
    );

  it('ちからのハチマキ: バトル場なら +20', () => {
    const b = board(PLAIN.functionalId, [attachTool(MUSCLE_BAND.functionalId)]);
    expect(modifier(b)).toMatchObject({ delta: 20 });
  });

  it('★ちからのハチマキ: ベンチのポケモンにつけても効かない（where: active）', () => {
    const b = board(PLAIN.functionalId, [], {
      benchFid: PLAIN.functionalId,
      benchAttach: [attachTool(MUSCLE_BAND.functionalId)],
    });
    // ハチマキはベンチのポケモンについている。そのポケモンを与える側にしても効かない
    expect(
      b.state.players[ALICE]!.pokemon.find((s) => s.slotId === 'bench-0')?.attachedTool,
    ).toBe(b.ids['bench-attach-0']);
    expect(
      continuousDamageModifier(
        b.state,
        { playerId: ALICE, slotId: 'bench-0' },
        { playerId: BOB, slotId: 'active' },
        'step2',
        ctx,
      ).delta,
    ).toBe(0);
    // バトル場のポケモンにも（ついていないので）効かない
    expect(modifier(b).delta).toBe(0);
  });

  it('★たつじんのおび: 相手がポケモンEXのときだけ +30', () => {
    const vsPlain = board(PLAIN.functionalId, [attachTool(EXPERT_BELT.functionalId)]);
    expect(modifier(vsPlain).delta).toBe(0);

    const vsEx = board(PLAIN.functionalId, [attachTool(EXPERT_BELT.functionalId)], {
      opponentFid: EX_MON.functionalId,
    });
    expect(modifier(vsEx)).toMatchObject({ delta: 30 });
  });

  it('★ストロングエネルギー: 闘ポケモンにつけたときだけ +20', () => {
    const onFighter = board(FIGHTER.functionalId, [attachEnergy(STRONG.functionalId)]);
    expect(modifier(onFighter).delta).toBe(20);

    const onWater = board(PLAIN.functionalId, [attachEnergy(STRONG.functionalId)]);
    expect(modifier(onWater).delta).toBe(0);
    // ★エネルギーとしても、闘でなければはたらかない
    expect(valueOn(onWater).amount).toBe(0);
  });

  it('ダブルターボエネルギーは −20。効果の名前も出る', () => {
    const b = board(PLAIN.functionalId, [attachEnergy(DOUBLE_TURBO.functionalId)]);
    expect(modifier(b).delta).toBe(-20);
    expect(modifier(b).sources[0]).toContain('ダブルターボ');
  });

  it('★6段パイプラインに合流する（Step2 に入る）', () => {
    const b = board(PLAIN.functionalId, [attachTool(MUSCLE_BAND.functionalId)]);
    const result = runDamagePipeline(
      damageInputFromState(
        b.state,
        ctx,
        { playerId: ALICE, slotId: 'active' },
        { playerId: BOB, slotId: 'active' },
        { baseDamage: 100, attackerTypes: ['water'], defender: PLAIN, targetIsBench: false },
      ),
    );
    const step2 = result.steps.find((s) => s.step === 2)!;
    expect(step2.applied).toBe(true);
    expect(step2.value).toBe(120);
    expect(step2.sources[0]).toContain('ちからのハチマキ');
    expect(result.finalDamage).toBe(120);
  });
});

// ── ウィークガードエネルギー ──────────

describe('★ウィークガードエネルギー: 弱点だけを計算しない', () => {
  /** ボブのバトル場に FIGHTER（水弱点×2）を置き、そこにウィークガードをつける */
  function guarded(withGuard: boolean): GameState {
    const b = board(PLAIN.functionalId, [], { opponentFid: FIGHTER.functionalId });
    if (!withGuard) return b.state;
    const guardId = instance(WEAKNESS_GUARD.functionalId, BOB).instanceId;
    const withCard: GameState = {
      ...b.state,
      cards: {
        ...b.state.cards,
        [guardId]: {
          instanceId: guardId,
          functionalId: WEAKNESS_GUARD.functionalId,
          ownerId: BOB,
          zone: 'hand',
          visibleTo: [BOB],
          faceUp: false,
        },
      },
    };
    return applyAction(
      withCard,
      act(
        { type: 'attachCard', playerId: BOB, slotId: 'active', cardId: guardId, as: 'energy' },
        BOB,
      ),
      ctx,
    );
  }

  const damage = (state: GameState) =>
    runDamagePipeline(
      damageInputFromState(
        state,
        ctx,
        { playerId: ALICE, slotId: 'active' },
        { playerId: BOB, slotId: 'active' },
        { baseDamage: 100, attackerTypes: ['water'], defender: FIGHTER, targetIsBench: false },
      ),
    );

  it('ついていなければ弱点×2 が乗る', () => {
    expect(damage(guarded(false)).finalDamage).toBe(200);
  });

  it('★ついていれば弱点は計算しない', () => {
    const state = guarded(true);
    expect(ignoresWeakness(state, BOB, 'active', ctx)).toBe(true);
    const result = damage(state);
    expect(result.steps.find((s) => s.step === 3)?.detail).toBe('計算しない');
    expect(result.finalDamage).toBe(100);
  });

  it('★抵抗力は残る（「弱点・抵抗力を計算しない」とは別物）', () => {
    const resistant: CardText = {
      ...FIGHTER,
      resistance: { type: 'water', modifier: '-20' },
    };
    const state = guarded(true);
    const result = runDamagePipeline(
      damageInputFromState(
        state,
        { cards: buildCardIndex([...POOL, resistant]) },
        { playerId: ALICE, slotId: 'active' },
        { playerId: BOB, slotId: 'active' },
        { baseDamage: 100, attackerTypes: ['water'], defender: resistant, targetIsBench: false },
      ),
    );
    expect(result.steps.find((s) => s.step === 3)?.applied).toBe(false);
    expect(result.steps.find((s) => s.step === 4)?.applied).toBe(true);
    expect(result.finalDamage).toBe(80);
  });
});
