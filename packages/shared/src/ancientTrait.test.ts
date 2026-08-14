/**
 * T39 の完了条件:
 *   1. ★Ωバリア持ちがトレーナーズの対象にならない
 *   2. ★Ω連打でワザを2回使える
 *
 * あわせて「選択型の古代能力（使うか使わないかを選べる）」が動くことも確かめる。
 * 古代能力は特性とは別枠なので、★特性ロックでは止まらない。
 */
import { describe, expect, it } from 'vitest';
import { applyAction, applyActions, type Action } from './actions';
import { buildCardIndex } from './cards';
import { createGameState, withCards } from './gameState';
import {
  attackAllowanceFor,
  canAttackAgain,
  getEffectiveAbilities,
  isImmuneToEffectFrom,
} from './derived';
import { effectSlotKey } from './effects';
import { canStep, shieldedFromThisEffect } from './interpreter';
import { WARNING_CODES, type RuleContext } from './rules';
import { ALICE, BOB, tick } from './testFixtures';
import type { EffectSource, Op } from './dsl';
import type { CardInstance, CardText, GameState, PlayerId } from './types';

const act = <T extends Omit<Action, 'actorId' | 'at'>>(a: T, actorId: PlayerId = ALICE): Action =>
  ({ ...a, actorId, at: tick() }) as Action;

// ── カード定義 ────────────────────────

const mon = (over: Partial<CardText> & Pick<CardText, 'functionalId' | 'name'>): CardText => ({
  supertype: 'pokemon',
  hp: 120,
  types: ['fire'],
  stage: 'basic',
  ruleBox: null,
  attacks: [{ name: 'たいあたり', cost: ['colorless'], damage: '30', text: '' }],
  weakness: null,
  resistance: null,
  retreatCost: 1,
  ...over,
});

const PLAIN = mon({ functionalId: 'fn-plain', name: 'ゼニガメ' });

/** ★Ωバリア。古代能力なので特性ロックでは止まらない */
const OMEGA_BARRIER = mon({
  functionalId: 'fn-barrier',
  name: 'Ωバリア持ち',
  abilities: [
    {
      name: 'Ωバリア',
      kind: 'ancientTrait',
      text: 'このポケモンは、相手のトレーナーズの効果を受けない。',
      trigger: 'passive',
    },
  ],
  continuous: [{ kind: 'effectImmunity', scope: 'self', on: 'attached', from: ['trainer'] }],
});

/** ★Ω連打。1つの番にワザを2回使える */
const OMEGA_BARRAGE = mon({
  functionalId: 'fn-barrage',
  name: 'Ω連打持ち',
  abilities: [
    {
      name: 'Ω連打',
      kind: 'ancientTrait',
      text: 'このポケモンは、自分の番にワザを2回使える。',
      trigger: 'passive',
    },
  ],
  continuous: [{ kind: 'extraAttack', scope: 'self', on: 'attached', count: 1 }],
});

/** 選択型の古代能力（使うか使わないかを選べる） */
const ALPHA_GROWTH = mon({
  functionalId: 'fn-alpha',
  name: 'αグロウ持ち',
  abilities: [
    {
      name: 'αグロウ',
      kind: 'ancientTrait',
      text: '使うと山札を1枚引く。',
      effects: [{ op: 'draw', player: 'self', count: 1 }],
    },
  ],
});

/** 全ポケモンの特性を止めるスタジアム。★古代能力は止まらないことを確かめる */
const LOCK_STADIUM: CardText = {
  functionalId: 'fn-lock',
  name: 'ダミーの特性ロック',
  supertype: 'trainer',
  trainerKind: 'stadium',
  text: 'すべての特性がなくなる。',
  continuous: [{ kind: 'lockAbilities', scope: 'all' }],
};

/** 相手のベンチを引きずり出すサポート（ボスの指令相当） */
const BOSS: CardText = {
  functionalId: 'fn-boss',
  name: 'ダミーのボスの指令',
  supertype: 'trainer',
  trainerKind: 'supporter',
  text: '相手のベンチポケモンをバトル場と入れ替える。',
  effects: [{ op: 'switch', side: 'opponent', chooser: 'self' }],
};

/** 相手のポケモンにダメカンを置くグッズ */
const HAMMER: CardText = {
  functionalId: 'fn-hammer',
  name: 'ダミーのダメカングッズ',
  supertype: 'trainer',
  trainerKind: 'item',
  text: '相手のポケモン1匹にダメカンを3個。',
  effects: [
    {
      op: 'damageCounter',
      action: 'place',
      count: 3,
      distribution: 'single',
      target: { kind: 'choose', player: 'opponent', chooser: 'self' },
    },
  ],
};

const ctx: RuleContext = {
  cards: buildCardIndex([PLAIN, OMEGA_BARRIER, OMEGA_BARRAGE, ALPHA_GROWTH, LOCK_STADIUM, BOSS, HAMMER]),
};

const card = (instanceId: string, fid: string, ownerId: PlayerId = ALICE): CardInstance => ({
  instanceId,
  functionalId: fid,
  ownerId,
  zone: 'deck',
  visibleTo: [],
  faceUp: false,
});

/**
 * アリス: バトル場に PLAIN、ベンチ0に `aliceBench`。
 * ボブ  : バトル場に PLAIN、ベンチ0に `bobBench`。
 */
function table(aliceBench = 'fn-barrage', bobBench = 'fn-barrier'): GameState {
  const base = createGameState({
    gameId: 'g-ancient',
    rngSeed: 'seed',
    seats: [
      { playerId: ALICE, displayName: 'アリス' },
      { playerId: BOB, displayName: 'ボブ' },
    ],
  });
  const cards: CardInstance[] = [
    card('a-active', 'fn-plain'),
    card('a-bench', aliceBench),
    card('a-boss', 'fn-boss'),
    card('a-hammer', 'fn-hammer'),
    card('a-stadium', 'fn-lock'),
    card('b-active', 'fn-plain', BOB),
    card('b-bench', bobBench, BOB),
  ];
  for (let i = 0; i < 6; i += 1) cards.push(card(`a-deck-${i}`, 'fn-plain'));

  return applyActions(
    withCards({ ...base, phase: 'turn', turn: 3, setup: null }, cards),
    [
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-active' }),
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'bench-0', cardId: 'a-bench' }),
      act({ type: 'placePokemon', playerId: BOB, slotId: 'active', cardId: 'b-active' }, BOB),
      act({ type: 'placePokemon', playerId: BOB, slotId: 'bench-0', cardId: 'b-bench' }, BOB),
    ],
    ctx,
  );
}

/** アリスがトレーナーズを使う（発生源をそのカードにする） */
function useTrainer(state: GameState, instanceId: string, ops: Op[]): GameState {
  const source: EffectSource = { instanceId, playerId: ALICE, label: 'テスト' };
  let next = applyAction(
    state,
    act({ type: 'startEffect', executionId: `x-${tick()}`, ops, source }),
    ctx,
  );
  for (let i = 0; i < 10 && canStep(next); i += 1) {
    next = applyAction(next, act({ type: 'effectStep', executionId: next.execution!.executionId }), ctx);
  }
  return next;
}

const lastWarnings = (state: GameState): string[] =>
  (state.log[state.log.length - 1]?.warnings ?? []).map((w) => w.code);

// ── ★1. Ωバリア ─────────────────────

describe('★Ωバリア持ちは相手のトレーナーズの対象にならない', () => {
  const state = table();

  it('守られているかを判定できる', () => {
    expect(isImmuneToEffectFrom(state, BOB, 'bench-0', 'trainer', ctx)).toBe(true);
    expect(isImmuneToEffectFrom(state, BOB, 'active', 'trainer', ctx)).toBe(false);
  });

  it('★相手のサポートでベンチから引きずり出せない', () => {
    const after = useTrainer(state, 'a-boss', BOSS.effects!);
    // 相手のベンチは Ωバリア持ちだけ → 選ぶ余地がなく、何も起きずに終わる
    expect(after.execution).toBeNull();
    expect(after.players[BOB]!.pokemon.find((p) => p.slotId === 'active')?.stack).toEqual([
      'b-active',
    ]);
  });

  it('★相手のグッズの選択候補にも出てこない', () => {
    const after = useTrainer(state, 'a-hammer', HAMMER.effects!);
    const choice = after.execution?.pendingChoice;
    // 候補はボブのバトル場だけ。Ωバリア持ちのベンチは外れる
    expect(choice?.candidates).toEqual(['b-active']);
  });

  it('Ωバリアがいなければ、両方とも候補に出る', () => {
    const after = useTrainer(table('fn-barrage', 'fn-plain'), 'a-hammer', HAMMER.effects!);
    expect(after.execution?.pendingChoice?.candidates).toHaveLength(2);
  });

  it('★自分のポケモンには効かない（「相手の」トレーナーズだけ）', () => {
    const withOwnBarrier = table('fn-barrier', 'fn-plain');
    const execution = {
      executionId: 'x',
      ops: [],
      cursor: 0,
      bindings: {},
      pendingChoice: null,
      source: { instanceId: 'a-hammer', playerId: ALICE, label: 'テスト' },
    };
    expect(shieldedFromThisEffect(withOwnBarrier, execution, ALICE, 'bench-0', ctx)).toBe(false);
  });

  it('★ワザの効果は防がない（トレーナーズだけ）', () => {
    const execution = {
      executionId: 'x',
      ops: [],
      cursor: 0,
      bindings: {},
      pendingChoice: null,
      // 発生源がポケモン（＝ワザ）なら守られない
      source: { instanceId: 'a-active', playerId: ALICE, label: 'ワザ', attackIndex: 0 },
    };
    expect(shieldedFromThisEffect(state, execution, BOB, 'bench-0', ctx)).toBe(false);
  });

  it('★古代能力なので特性ロックでは止まらない', () => {
    const locked = applyAction(state, act({ type: 'setStadium', cardId: 'a-stadium' }), ctx);
    // 特性の一覧には残る（古代能力はロック対象外）
    expect(
      getEffectiveAbilities(locked, effectSlotKey(BOB, 'bench-0'), ctx).map((a) => a.name),
    ).toEqual(['Ωバリア']);
    // 守りもはたらいたまま
    expect(isImmuneToEffectFrom(locked, BOB, 'bench-0', 'trainer', ctx)).toBe(true);
  });
});

// ── ★2. Ω連打 ──────────────────────

describe('★Ω連打でワザを2回使える', () => {
  const attack = (state: GameState, slotId: 'active' | 'bench-0' = 'active'): GameState =>
    applyAction(
      state,
      act({ type: 'useAttack', playerId: ALICE, slotId, attackIndex: 0, attackName: 'たいあたり' }),
      ctx,
    );

  it('既定は1回', () => {
    expect(attackAllowanceFor(table(), ALICE, 'active', ctx)).toBe(1);
  });

  it('★Ω連打を持つポケモンは2回', () => {
    expect(attackAllowanceFor(table(), ALICE, 'bench-0', ctx)).toBe(2);
  });

  it('使った回数を数える', () => {
    const once = attack(table());
    expect(once.players[ALICE]!.turnFlags.attacksUsed).toBe(1);
    expect(canAttackAgain(once, ALICE, 'active', ctx)).toBe(false);
    // ★Ω連打持ちならまだ使える
    expect(canAttackAgain(once, ALICE, 'bench-0', ctx)).toBe(true);
  });

  it('★1回目は「あと1回使える」と知らせる（番はまだ終わらない）', () => {
    const once = attack(table(), 'bench-0');
    expect(lastWarnings(once)).toContain(WARNING_CODES.EXTRA_ATTACK_AVAILABLE);
    expect(lastWarnings(once)).not.toContain(WARNING_CODES.ATTACK_ALREADY_USED);
  });

  it('★2回目は知らせない（もう終わり）', () => {
    const twice = attack(attack(table(), 'bench-0'), 'bench-0');
    expect(twice.players[ALICE]!.turnFlags.attacksUsed).toBe(2);
    expect(lastWarnings(twice)).not.toContain(WARNING_CODES.EXTRA_ATTACK_AVAILABLE);
    expect(lastWarnings(twice)).not.toContain(WARNING_CODES.ATTACK_ALREADY_USED);
  });

  it('★3回目は警告が出る。ただし止めない', () => {
    const thrice = attack(attack(attack(table(), 'bench-0'), 'bench-0'), 'bench-0');
    expect(lastWarnings(thrice)).toContain(WARNING_CODES.ATTACK_ALREADY_USED);
    expect(thrice.players[ALICE]!.turnFlags.attacksUsed).toBe(3);
  });

  it('Ω連打がなければ2回目で警告', () => {
    const twice = attack(attack(table()));
    expect(lastWarnings(twice)).toContain(WARNING_CODES.ATTACK_ALREADY_USED);
  });

  it('番が変われば回数は戻る', () => {
    const ended = applyAction(attack(table()), act({ type: 'endTurn' }), ctx);
    // 次に番が回ってきた人のぶんが戻る
    const active = ended.activePlayer;
    expect(ended.players[active]!.turnFlags.attacksUsed).toBe(0);
  });

  it('★かかっている効果（ActiveEffect）でも回数を増やせる（指示書 §T39 の形）', () => {
    const state = table('fn-plain');
    expect(attackAllowanceFor(state, ALICE, 'bench-0', ctx)).toBe(1);

    const granted = applyAction(
      state,
      act({
        type: 'startEffect',
        executionId: 'x-grant',
        ops: [
          {
            op: 'applyEffect',
            effect: {
              target: { slot: { kind: 'bench', player: 'self', index: 0 } },
              applyAt: 'none',
              kind: 'extraAttack',
              payload: { count: 1, label: 'この番はワザを2回使える' },
              duration: { type: 'thisTurn' },
            },
          },
        ],
        source: { instanceId: null, playerId: ALICE, label: 'テスト効果' },
      }),
      ctx,
    );
    const stepped = applyAction(
      granted,
      act({ type: 'effectStep', executionId: 'x-grant' }),
      ctx,
    );
    expect(attackAllowanceFor(stepped, ALICE, 'bench-0', ctx)).toBe(2);
  });
});

// ── 選択型の古代能力 ───────────────────

describe('選択型の古代能力（使うか使わないかを選べる）', () => {
  it('★特性ロック中でも使える（古代能力は別枠）', () => {
    const state = applyAction(
      table('fn-alpha'),
      act({ type: 'setStadium', cardId: 'a-stadium' }),
      ctx,
    );
    const entries = getEffectiveAbilities(state, effectSlotKey(ALICE, 'bench-0'), ctx);
    expect(entries.map((a) => a.name)).toEqual(['αグロウ']);
  });

  it('使うと効果が動く', () => {
    const state = table('fn-alpha');
    const before = Object.values(state.cards).filter(
      (c) => c.ownerId === ALICE && c.zone === 'hand',
    ).length;

    let next = applyAction(
      state,
      act({
        type: 'startEffect',
        executionId: 'x-alpha',
        ops: ALPHA_GROWTH.abilities![0]!.effects!,
        source: { instanceId: 'a-bench', playerId: ALICE, label: 'αグロウ', abilityIndex: 0 },
      }),
      ctx,
    );
    for (let i = 0; i < 5 && canStep(next); i += 1) {
      next = applyAction(next, act({ type: 'effectStep', executionId: 'x-alpha' }), ctx);
    }
    expect(
      Object.values(next.cards).filter((c) => c.ownerId === ALICE && c.zone === 'hand').length,
    ).toBe(before + 1);
  });
});
