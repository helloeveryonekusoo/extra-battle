/**
 * T37 の完了条件:
 *   「ゾロアークBREAK等で、進化前のワザが使え、弱点は進化前のもの、HPはBREAK側になる」
 *
 * 引きつぐ: ワザ / 特性 / 弱点 / 抵抗力 / にげる
 * BREAK側 : タイプ / HP
 */
import { describe, expect, it } from 'vitest';
import { applyAction, applyActions, type Action } from './actions';
import { buildCardIndex } from './cards';
import { createGameState, withCards } from './gameState';
import {
  effectiveProfileOf,
  getEffectiveAttacks,
  getEffectiveHp,
  getEffectiveResistance,
  getEffectiveRetreatCost,
  getEffectiveTypes,
  getEffectiveWeakness,
  isBreakCard,
} from './effectiveCard';
import { canUseAbilityThisTurn, getEffectiveAbilities, getEffectiveAbilityEntries, getRetreatCost } from './derived';
import { effectSlotKey } from './effects';
import { remainingHpOf } from './knockout';
import type { RuleContext } from './rules';
import { ALICE, BOB, tick } from './testFixtures';
import type { CardInstance, CardText, GameState, PlayerId } from './types';

const act = <T extends Omit<Action, 'actorId' | 'at'>>(a: T, actorId: PlayerId = ALICE): Action =>
  ({ ...a, actorId, at: tick() }) as Action;

// ── カード定義（ゾロアーク / ゾロアークBREAK を模す） ──

const ZOROA: CardText = {
  functionalId: 'fn-zoroa',
  name: 'ゾロア',
  supertype: 'pokemon',
  hp: 60,
  types: ['darkness'],
  stage: 'basic',
  ruleBox: null,
  attacks: [{ name: 'ひっかく', cost: ['colorless'], damage: '10', text: '' }],
  weakness: { type: 'fighting', modifier: '×2' },
  resistance: null,
  retreatCost: 1,
};

/** 進化前。★ワザ・弱点・抵抗力・にげる・特性の出どころ */
const ZOROARK: CardText = {
  functionalId: 'fn-zoroark',
  name: 'ゾロアーク',
  supertype: 'pokemon',
  hp: 120,
  types: ['darkness'],
  stage: 'stage1',
  evolvesFrom: 'ゾロア',
  ruleBox: null,
  abilities: [
    {
      name: 'かえるすがた',
      kind: 'ability',
      text: '自分の番に1回使える。',
      oncePerTurn: true,
      effects: [{ op: 'draw', player: 'self', count: 1 }],
    },
  ],
  attacks: [
    { name: 'イカサマ', cost: ['darkness'], damage: '0', text: '相手のワザを使う。' },
    { name: 'ナイトダガー', cost: ['darkness', 'colorless'], damage: '60', text: '' },
  ],
  weakness: { type: 'fighting', modifier: '×2' },
  resistance: { type: 'psychic', modifier: '-20' },
  retreatCost: 1,
};

/** ★BREAK側。タイプとHPだけを持ち込む。ワザは持たない */
const ZOROARK_BREAK: CardText = {
  functionalId: 'fn-zoroark-break',
  name: 'ゾロアークBREAK',
  supertype: 'pokemon',
  hp: 190,
  types: ['darkness'],
  stage: 'break',
  evolvesFrom: 'ゾロアーク',
  ruleBox: 'BREAK',
  abilities: [
    {
      name: 'BREAKの特性',
      kind: 'ability',
      text: '自分の番に1回使える。',
      oncePerTurn: true,
      effects: [{ op: 'draw', player: 'self', count: 2 }],
    },
  ],
  attacks: [],
  weakness: null,
  resistance: null,
  retreatCost: 4,
};

/** 特性ロックのスタジアム（たねポケモン向け）。BREAKには効かないことを確かめる */
const SILENT_LAB: CardText = {
  functionalId: 'fn-silent',
  name: 'ダミーのサイレントラボ',
  supertype: 'trainer',
  trainerKind: 'stadium',
  text: 'たねポケモンの特性はなくなる。',
  continuous: [{ kind: 'lockAbilities', scope: 'all', filter: { stage: ['basic'] } }],
};

/** ルールを持つポケモンの特性を止めるスタジアム。BREAKには効く */
const PATH: CardText = {
  ...SILENT_LAB,
  functionalId: 'fn-path',
  name: 'ダミーの頂への雪道',
  continuous: [{ kind: 'lockAbilities', scope: 'all', filter: { ruleBox: 'any' } }],
};

const FLOAT_STONE: CardText = {
  functionalId: 'fn-float',
  name: 'ふうせん',
  supertype: 'trainer',
  trainerKind: 'tool',
  text: 'にげるが2個ぶん少なくなる。',
  continuous: [{ kind: 'retreatCost', scope: 'self', delta: -2, on: 'attached' }],
};

const PLAIN: CardText = { ...ZOROA, functionalId: 'fn-plain', name: 'ゼニガメ' };

const ctx: RuleContext = {
  cards: buildCardIndex([ZOROA, ZOROARK, ZOROARK_BREAK, SILENT_LAB, PATH, FLOAT_STONE, PLAIN]),
};

const card = (instanceId: string, fid: string, ownerId: PlayerId = ALICE): CardInstance => ({
  instanceId,
  functionalId: fid,
  ownerId,
  zone: 'deck',
  visibleTo: [],
  faceUp: false,
});

const KEY = effectSlotKey(ALICE, 'active');

/**
 * アリスのバトル場に ゾロア → ゾロアーク と進化させた盤面。
 * `toBreak` を立てるとさらに BREAK を重ねる。
 */
function table(toBreak: boolean): GameState {
  const base = createGameState({
    gameId: 'g-break',
    rngSeed: 'seed',
    seats: [
      { playerId: ALICE, displayName: 'アリス' },
      { playerId: BOB, displayName: 'ボブ' },
    ],
  });
  const cards = [
    card('a-zoroa', 'fn-zoroa'),
    card('a-zoroark', 'fn-zoroark'),
    card('a-break', 'fn-zoroark-break'),
    card('a-silent', 'fn-silent'),
    card('a-path', 'fn-path'),
    card('a-float', 'fn-float'),
    card('b-plain', 'fn-plain', BOB),
  ];
  const actions: Action[] = [
    act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-zoroa' }),
    act({ type: 'evolvePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-zoroark' }),
    act({ type: 'placePokemon', playerId: BOB, slotId: 'active', cardId: 'b-plain' }, BOB),
  ];
  if (toBreak) {
    actions.push(
      act({ type: 'evolvePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-break' }),
    );
  }
  return applyActions(
    withCards({ ...base, phase: 'turn', turn: 3, setup: null }, cards),
    actions,
    ctx,
  );
}

// ── ★完了条件 ────────────────────────

describe('★ゾロアークBREAK: 引きつぐもの / BREAK側を使うもの', () => {
  const before = table(false);
  const after = table(true);

  it('BREAKかどうかを見分けられる', () => {
    expect(isBreakCard(ZOROARK_BREAK)).toBe(true);
    expect(isBreakCard(ZOROARK)).toBe(false);
    expect(effectiveProfileOf(before, ALICE, 'active', ctx).isBreak).toBe(false);
    expect(effectiveProfileOf(after, ALICE, 'active', ctx).isBreak).toBe(true);
  });

  it('★進化前のワザが使える（BREAK側はワザを持たない）', () => {
    expect(getEffectiveAttacks(after, KEY, ctx).map((a) => a.name)).toEqual([
      'イカサマ',
      'ナイトダガー',
    ]);
    // 一番上のカードだけを見ていたら空になってしまう
    expect(ZOROARK_BREAK.attacks).toHaveLength(0);
  });

  it('★弱点は進化前のもの', () => {
    expect(getEffectiveWeakness(after, KEY, ctx)).toEqual({ type: 'fighting', modifier: '×2' });
    expect(ZOROARK_BREAK.weakness).toBeNull();
  });

  it('抵抗力も進化前のもの', () => {
    expect(getEffectiveResistance(after, KEY, ctx)).toEqual({ type: 'psychic', modifier: '-20' });
  });

  it('★HPはBREAK側', () => {
    expect(getEffectiveHp(after, KEY, ctx)).toBe(190);
    expect(getEffectiveHp(before, KEY, ctx)).toBe(120);
  });

  it('タイプもBREAK側', () => {
    expect(getEffectiveTypes(after, KEY, ctx)).toEqual(['darkness']);
  });

  it('★にげるは進化前のもの（BREAK側の4ではない）', () => {
    expect(getEffectiveRetreatCost(after, KEY, ctx)).toBe(1);
    expect(ZOROARK_BREAK.retreatCost).toBe(4);
  });

  it('★どうぐの増減は、引きついだ にげる を土台にする', () => {
    const withStone = applyAction(
      table(true),
      act({ type: 'attachCard', playerId: ALICE, slotId: 'active', cardId: 'a-float', as: 'tool' }),
      ctx,
    );
    // 進化前の1 から ふうせんの−2 → 0未満にはならない
    expect(getRetreatCost(withStone, ALICE, 'active', ctx)).toBe(0);
  });

  it('★きぜつ判定はBREAK側のHPで行う（一番上のカードのHPなので自然に成立）', () => {
    const damaged = applyAction(
      table(true),
      act({ type: 'adjustDamage', playerId: ALICE, slotId: 'active', delta: 13 }),
      ctx,
    );
    const slot = damaged.players[ALICE]!.pokemon[0]!;
    // 190 − 130 = 60。進化前の120基準なら負けているはずの場面
    expect(remainingHpOf(damaged, ctx, slot)).toBe(60);
  });
});

// ── ★特性は両方使える ───────────────────

describe('★特性は進化前とBREAK側の両方が使える', () => {
  it('合成すると2つ出てくる', () => {
    const entries = getEffectiveAbilityEntries(table(true), KEY, ctx);
    expect(entries.map((e) => e.ability.name)).toEqual(['かえるすがた', 'BREAKの特性']);
  });

  it('★どのカードの何番目かが分かる（使用回数は CardInstance 単位のため）', () => {
    const entries = getEffectiveAbilityEntries(table(true), KEY, ctx);
    expect(entries[0]).toMatchObject({ instanceId: 'a-zoroark', abilityIndex: 0 });
    expect(entries[1]).toMatchObject({ instanceId: 'a-break', abilityIndex: 0 });
  });

  it('★進化前の「番に1回」を使っていたら、BREAKに進化しても同じ番に再使用できない', () => {
    // ゾロアークのうちに かえるすがた を使う
    const used = applyAction(
      table(false),
      act({
        type: 'startEffect',
        executionId: 'x1',
        ops: [{ op: 'draw', player: 'self', count: 1 }],
        source: { instanceId: 'a-zoroark', playerId: ALICE, label: 'かえるすがた', abilityIndex: 0 },
      }),
      ctx,
    );
    expect(canUseAbilityThisTurn(used, 'a-zoroark', 0)).toBe(false);

    // そのままBREAKに進化する
    const evolved = applyAction(
      used,
      act({ type: 'evolvePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-break' }),
      ctx,
    );
    // ★進化前の特性は使えないまま（実体ごとに数えているので何もしなくても成立する）
    expect(canUseAbilityThisTurn(evolved, 'a-zoroark', 0)).toBe(false);
    // ★BREAK側の特性は別の実体なので、同じ番に使える
    expect(canUseAbilityThisTurn(evolved, 'a-break', 0)).toBe(true);
  });

  it('BREAKでなければ、一番上のカードの特性だけ', () => {
    expect(getEffectiveAbilities(table(false), KEY, ctx).map((a) => a.name)).toEqual([
      'かえるすがた',
    ]);
  });
});

// ── ロックとの組み合わせ ─────────────────

describe('ロックの判定は場に出ているポケモン（＝BREAK側）で行う', () => {
  const withStadium = (cardId: string): GameState =>
    applyAction(table(true), act({ type: 'setStadium', cardId }), ctx);

  it('★「たねポケモンの特性を止める」はBREAKには効かない', () => {
    // BREAK側の stage は 'break' なので、たね向けのロックに当たらない
    expect(getEffectiveAbilities(withStadium('a-silent'), KEY, ctx)).toHaveLength(2);
  });

  it('★「ルールを持つポケモンの特性を止める」はBREAKに効く（引きついだぶんも止まる）', () => {
    // BREAK は ruleBox: 'BREAK' を持つので当たる。下から引きついだ特性ごと止まる
    expect(getEffectiveAbilities(withStadium('a-path'), KEY, ctx)).toHaveLength(0);
  });
});

// ── BREAKでないときは今までどおり ────────

describe('BREAKでないポケモンは一番上のカードがすべて', () => {
  it('ワザ・弱点・にげる・HP がすべて一番上から出る', () => {
    const state = table(false);
    expect(getEffectiveAttacks(state, KEY, ctx).map((a) => a.name)).toEqual([
      'イカサマ',
      'ナイトダガー',
    ]);
    expect(getEffectiveWeakness(state, KEY, ctx)).toEqual(ZOROARK.weakness);
    expect(getEffectiveRetreatCost(state, KEY, ctx)).toBe(1);
    expect(getEffectiveHp(state, KEY, ctx)).toBe(120);
  });

  it('スロットが空なら空の姿を返す（落ちない）', () => {
    const state = table(false);
    const empty = effectiveProfileOf(state, ALICE, 'bench-3', ctx);
    expect(empty.attacks).toEqual([]);
    expect(empty.isBreak).toBe(false);
    expect(getEffectiveHp(state, effectSlotKey(ALICE, 'bench-3'), ctx)).toBeUndefined();
  });
});
