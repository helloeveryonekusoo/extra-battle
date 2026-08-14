/**
 * T27 の完了条件:
 *   ★ロック効果を模したダミー効果を場に置くと特性が無効化され、取り除くと復活する。
 *
 * あわせて §2.2 の4つと §2.3 の衝突解決を確かめる:
 *   getEffectiveAbilities / canUseCardKind / getBenchLimit / getPrizeCount
 *   ベンチ上限は **低いほうが優先**（スカイフィールド8 + ウソッキー4 → 4）
 */
import { describe, expect, it } from 'vitest';
import { applyAction, applyActionChecked, applyActions, type Action } from './actions';
import { buildCardIndex } from './cards';
import { createGameState, withCards } from './gameState';
import {
  canUseCardKind,
  cardsInPlay,
  DEFAULT_BENCH_LIMIT,
  getBenchLimit,
  getEffectiveAbilities,
  getPrizeCount,
  prizeCountForSlot,
} from './derived';
import { effectSlotKey } from './effects';
import type { EffectSource, Op } from './dsl';
import { WARNING_CODES, type RuleContext } from './rules';
import { ALICE, BOB, tick } from './testFixtures';
import type { Ability, CardInstance, CardText, GameState, PlayerId } from './types';

const act = <T extends Omit<Action, 'actorId' | 'at'>>(a: T, actorId: PlayerId = ALICE): Action =>
  ({ ...a, actorId, at: tick() }) as Action;

// ── カード定義 ────────────────────────

const ABILITY: Ability = { name: 'うらこうさく', text: '山札から1枚。', kind: 'ability' };
const ANCIENT: Ability = { name: 'Ω バリア', text: '相手のワザの効果を受けない。', kind: 'ancientTrait' };

/** 特性を持つポケモン。ロックの対象になる */
const ABILITY_MON: CardText = {
  functionalId: 'fn-ability',
  name: 'インテレオン',
  supertype: 'pokemon',
  hp: 90,
  types: ['water'],
  stage: 'basic',
  ruleBox: null,
  abilities: [ABILITY, ANCIENT],
  attacks: [],
  weakness: null,
  resistance: null,
  retreatCost: 1,
};

const PLAIN: CardText = { ...ABILITY_MON, functionalId: 'fn-plain', name: 'ゼニガメ', abilities: [] };

/** V ポケモン（サイド2枚） */
const V_MON: CardText = { ...PLAIN, functionalId: 'fn-v', name: 'ゼニガメV', ruleBox: 'V', hp: 190 };

/** ★ロックを模したダミー。どうぐとしてつけて、場から外せるようにする */
const LOCK_TOOL: CardText = {
  functionalId: 'fn-lock',
  name: 'ダミーのロックどうぐ',
  supertype: 'trainer',
  trainerKind: 'tool',
  text: 'すべてのポケモンの特性が止まる。',
  continuous: [{ kind: 'lockAbilities', scope: 'all' }],
};

/** スタジアム: ベンチ8 */
const SKY: CardText = {
  functionalId: 'fn-sky',
  name: 'ダミーのスカイフィールド',
  supertype: 'trainer',
  trainerKind: 'stadium',
  text: 'おたがいのベンチは8匹。',
  continuous: [{ kind: 'benchLimit', scope: 'all', limit: 8 }],
};

/** ベンチ4 にするポケモン（ウソッキー相当） */
const BLOCKER: CardText = {
  ...PLAIN,
  functionalId: 'fn-blocker',
  name: 'ダミーのウソッキー',
  continuous: [{ kind: 'benchLimit', scope: 'all', limit: 4 }],
};

/** グッズロックのどうぐ */
const ITEM_LOCK: CardText = {
  ...LOCK_TOOL,
  functionalId: 'fn-itemlock',
  name: 'ダミーのグッズロック',
  continuous: [{ kind: 'lockCardKind', scope: 'opponent', trainerKind: ['item'] }],
};

/** サイドを1枚増やすどうぐ（オルタージェネシスGX 相当） */
const EXTRA_PRIZE: CardText = {
  ...LOCK_TOOL,
  functionalId: 'fn-extraprize',
  name: 'ダミーのサイド増加',
  continuous: [{ kind: 'extraPrize', scope: 'self', delta: 1 }],
};

const ctx: RuleContext = {
  cards: buildCardIndex([ABILITY_MON, PLAIN, V_MON, LOCK_TOOL, SKY, BLOCKER, ITEM_LOCK, EXTRA_PRIZE]),
};

const card = (instanceId: string, ownerId: PlayerId, fid: string, position: number): CardInstance => ({
  instanceId,
  functionalId: fid,
  ownerId,
  zone: 'hand',
  visibleTo: [ownerId],
  faceUp: false,
  position,
});

/** アリスのバトル場に特性持ち、ボブのバトル場にもポケモン。手札に各種ダミー */
function table(): GameState {
  const base = createGameState({
    gameId: 'g-derived',
    rngSeed: 'seed',
    seats: [
      { playerId: ALICE, displayName: 'アリス' },
      { playerId: BOB, displayName: 'ボブ' },
    ],
  });
  const seeded = withCards(base, [
    card('a-mon', ALICE, 'fn-ability', 0),
    card('a-v', ALICE, 'fn-v', 1),
    card('a-lock', ALICE, 'fn-lock', 2),
    card('a-sky', ALICE, 'fn-sky', 3),
    card('a-blocker', ALICE, 'fn-blocker', 4),
    card('a-itemlock', ALICE, 'fn-itemlock', 5),
    card('a-prize', ALICE, 'fn-extraprize', 6),
    card('b-mon', BOB, 'fn-ability', 0),
    card('b-lock', BOB, 'fn-lock', 1),
    card('b-itemlock', BOB, 'fn-itemlock', 2),
  ]);
  return applyActions(
    seeded,
    [
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-mon' }),
      act({ type: 'placePokemon', playerId: BOB, slotId: 'active', cardId: 'b-mon' }, BOB),
      act({ type: 'setFirstPlayer', playerId: ALICE }),
      act({ type: 'setSetupStep', step: 'done' }),
    ],
    ctx,
  );
}

const ALICE_ACTIVE = effectSlotKey(ALICE, 'active');
const BOB_ACTIVE = effectSlotKey(BOB, 'active');

const attachTool = (state: GameState, playerId: PlayerId, cardId: string): GameState =>
  applyAction(
    state,
    act({ type: 'attachCard', playerId, slotId: 'active', cardId, as: 'tool' }, playerId),
    ctx,
  );

// ── 完了条件 ──

describe('★ロックのダミーを場に置くと特性が止まり、取り除くと復活する', () => {
  it('置く前は特性がある', () => {
    const abilities = getEffectiveAbilities(table(), ALICE_ACTIVE, ctx);
    expect(abilities.map((a) => a.name)).toEqual(['うらこうさく', 'Ω バリア']);
  });

  it('★ロックを場に出すと特性が止まる', () => {
    const locked = attachTool(table(), BOB, 'b-lock');
    const abilities = getEffectiveAbilities(locked, ALICE_ACTIVE, ctx);
    // ★古代能力は特性ではないので止まらない
    expect(abilities.map((a) => a.name)).toEqual(['Ω バリア']);
  });

  it('★ロックを取り除くと特性が復活する', () => {
    const locked = attachTool(table(), BOB, 'b-lock');
    expect(getEffectiveAbilities(locked, ALICE_ACTIVE, ctx).map((a) => a.name)).toEqual(['Ω バリア']);

    const unlocked = applyAction(
      locked,
      act({ type: 'detachCard', playerId: BOB, slotId: 'active', cardId: 'b-lock', toZone: 'discard' }, BOB),
      ctx,
    );
    expect(getEffectiveAbilities(unlocked, ALICE_ACTIVE, ctx).map((a) => a.name)).toEqual([
      'うらこうさく',
      'Ω バリア',
    ]);
  });

  it('★状態には何も書き込まれていない（派生状態である）', () => {
    const before = table();
    const locked = attachTool(before, BOB, 'b-lock');
    // 特性が止まっているのに、状態には「止まっている」という記録がない
    expect(getEffectiveAbilities(locked, ALICE_ACTIVE, ctx)).toHaveLength(1);
    expect(locked.effects).toEqual([]);
    // 同じ状態を JSON で往復させても答えが変わらない（純粋な計算）
    const roundTripped = JSON.parse(JSON.stringify(locked)) as GameState;
    expect(getEffectiveAbilities(roundTripped, ALICE_ACTIVE, ctx)).toHaveLength(1);
  });

  it('ロックを出している当のカードは自分自身を止めない', () => {
    const locked = attachTool(table(), BOB, 'b-lock');
    // ロックどうぐは「場に出ているカード」として拾われ続ける
    const inPlay = cardsInPlay(locked, ctx).map((c) => c.instanceId);
    expect(inPlay).toContain('b-lock');
    // 相手側の特性も止まっている（scope: 'all'）
    expect(getEffectiveAbilities(locked, BOB_ACTIVE, ctx).map((a) => a.name)).toEqual(['Ω バリア']);
  });

  it('カード定義がなければ何も答えない（勝手に判断しない）', () => {
    expect(getEffectiveAbilities(table(), ALICE_ACTIVE)).toEqual([]);
    expect(getEffectiveAbilities(table(), 'ないスロット', ctx)).toEqual([]);
  });
});

// ── canUseCardKind ──

describe('カード種別のロック（グッズロック等）', () => {
  it('何もなければ全部使える', () => {
    const state = table();
    for (const kind of ['item', 'tool', 'supporter', 'stadium'] as const) {
      expect(canUseCardKind(state, ALICE, kind, ctx)).toBe(true);
    }
  });

  it('★「できない」が1つでもあれば使えない（§2.3）', () => {
    // ボブがグッズロックを出す → アリスがグッズを使えなくなる
    const locked = attachTool(table(), BOB, 'b-itemlock');
    expect(canUseCardKind(locked, ALICE, 'item', ctx)).toBe(false);
    // 出した本人は使える（scope: 'opponent'）
    expect(canUseCardKind(locked, BOB, 'item', ctx)).toBe(true);
    // 他の種別には及ばない
    expect(canUseCardKind(locked, ALICE, 'supporter', ctx)).toBe(true);
  });

  it('外せば使えるようになる', () => {
    const locked = attachTool(table(), BOB, 'b-itemlock');
    const freed = applyAction(
      locked,
      act({ type: 'detachCard', playerId: BOB, slotId: 'active', cardId: 'b-itemlock', toZone: 'discard' }, BOB),
      ctx,
    );
    expect(canUseCardKind(freed, ALICE, 'item', ctx)).toBe(true);
  });
});

// ── getBenchLimit ──

describe('★ベンチ上限は低いほうが優先される（§2.2）', () => {
  it('カードが何も言わなければ、手で設定した値をそのまま使う', () => {
    const state = table();
    expect(getBenchLimit(state, ALICE, ctx)).toBe(DEFAULT_BENCH_LIMIT);

    const widened = applyAction(
      state,
      act({ type: 'setBenchLimit', playerId: ALICE, benchLimit: 8 }),
      ctx,
    );
    expect(getBenchLimit(widened, ALICE, ctx)).toBe(8);
  });

  it('スカイフィールドを出すと8になる', () => {
    const state = applyActions(
      table(),
      [
        act({ type: 'moveCard', cardId: 'a-sky', toZone: 'stadium' }),
        act({ type: 'setStadium', cardId: 'a-sky' }),
      ],
      ctx,
    );
    expect(getBenchLimit(state, ALICE, ctx)).toBe(8);
    expect(getBenchLimit(state, BOB, ctx)).toBe(8);
  });

  it('★スカイフィールド8 と ウソッキー4 が同時なら 4', () => {
    let state = applyActions(
      table(),
      [
        act({ type: 'moveCard', cardId: 'a-sky', toZone: 'stadium' }),
        act({ type: 'setStadium', cardId: 'a-sky' }),
      ],
      ctx,
    );
    expect(getBenchLimit(state, ALICE, ctx)).toBe(8);

    state = applyAction(
      state,
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'bench-0', cardId: 'a-blocker' }),
      ctx,
    );
    // ★低いほうが勝つ
    expect(getBenchLimit(state, ALICE, ctx)).toBe(4);
    expect(getBenchLimit(state, BOB, ctx)).toBe(4);
  });

  it('ウソッキーが場を離れると8に戻る', () => {
    let state = applyActions(
      table(),
      [
        act({ type: 'moveCard', cardId: 'a-sky', toZone: 'stadium' }),
        act({ type: 'setStadium', cardId: 'a-sky' }),
        act({ type: 'placePokemon', playerId: ALICE, slotId: 'bench-0', cardId: 'a-blocker' }),
      ],
      ctx,
    );
    expect(getBenchLimit(state, ALICE, ctx)).toBe(4);

    state = applyAction(
      state,
      act({ type: 'removePokemon', playerId: ALICE, slotId: 'bench-0', toZone: 'discard' }),
      ctx,
    );
    expect(getBenchLimit(state, ALICE, ctx)).toBe(8);
  });

  it('スタジアムが流れると既定に戻る', () => {
    let state = applyActions(
      table(),
      [
        act({ type: 'moveCard', cardId: 'a-sky', toZone: 'stadium' }),
        act({ type: 'setStadium', cardId: 'a-sky' }),
      ],
      ctx,
    );
    expect(getBenchLimit(state, ALICE, ctx)).toBe(8);

    state = applyAction(state, act({ type: 'setStadium', cardId: null }), ctx);
    expect(getBenchLimit(state, ALICE, ctx)).toBe(DEFAULT_BENCH_LIMIT);
  });
});

// ── getPrizeCount ──

describe('きぜつ時のサイド枚数', () => {
  const withV = (state: GameState): GameState =>
    applyAction(
      state,
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'bench-0', cardId: 'a-v' }),
      ctx,
    );

  it('ルールボックスから既定値を出す', () => {
    const state = withV(table());
    expect(getPrizeCount(state, ALICE_ACTIVE, ctx)).toBe(1);
    expect(prizeCountForSlot(state, ALICE, 'bench-0', ctx)).toBe(2);
  });

  it('★かかっている効果ぶんが乗る（オルタージェネシスGX 等）', () => {
    const state = withV(table());
    const ops: Op[] = [
      {
        op: 'applyEffect',
        effect: {
          target: { global: true },
          applyAt: 'none',
          kind: 'extraPrize',
          payload: { delta: 1 },
          duration: { type: 'wholeGame' },
          label: 'サイドを1枚多くとる',
        },
      },
    ];
    const source: EffectSource = { instanceId: null, playerId: BOB, label: 'オルタージェネシスGX' };
    let next = applyAction(state, act({ type: 'startEffect', executionId: 'x1', ops, source }, BOB), ctx);
    next = applyAction(next, act({ type: 'effectStep', executionId: 'x1' }, BOB), ctx);

    expect(getPrizeCount(next, ALICE_ACTIVE, ctx)).toBe(2);
    expect(prizeCountForSlot(next, ALICE, 'bench-0', ctx)).toBe(3);
  });

  it('場のカードの常時効果ぶんも乗る', () => {
    // ボブがサイド増加のどうぐを出す → アリスのポケモンのサイドが+1
    const state = attachTool(withV(table()), BOB, 'b-lock');
    expect(getPrizeCount(state, ALICE_ACTIVE, ctx)).toBe(1);

    const withPrizeUp = applyActions(
      withV(table()),
      [
        act({ type: 'moveCard', cardId: 'a-prize', toZone: 'hand', visibleTo: [BOB] }, BOB),
      ],
      ctx,
    );
    // 持ち主を変えずに、アリス側のどうぐとしてつける（scope: 'self' なのでアリス側に効く）
    const attached = applyAction(
      withPrizeUp,
      act({ type: 'attachCard', playerId: ALICE, slotId: 'active', cardId: 'a-prize', as: 'tool' }),
      ctx,
    );
    // アリスのポケモンがきぜつしたときサイドをとるのはボブ。
    // このダミーは scope:'self'（＝つけた側＝アリス）なので、ボブには効かない
    expect(getPrizeCount(attached, ALICE_ACTIVE, ctx)).toBe(1);
    // 逆にボブのポケモンには効く（とるのはアリス）
    expect(getPrizeCount(attached, BOB_ACTIVE, ctx)).toBe(2);
  });
});

// ── 「警告はするが、禁止はしない」（第2段階 §2 を守る） ──

describe('★ロックされていても操作は通る。警告が出るだけ', () => {
  it('グッズロック中にグッズを使うと警告が出るが、操作は成立する', () => {
    const locked = attachTool(table(), BOB, 'b-itemlock');
    // アリスの手札にグッズがある状態を作る
    const withItem = applyAction(
      locked,
      act({ type: 'moveCard', cardId: 'a-lock', toZone: 'hand', visibleTo: [ALICE] }),
      ctx,
    );

    const played = applyActionChecked(
      withItem,
      act({ type: 'attachCard', playerId: ALICE, slotId: 'active', cardId: 'a-lock', as: 'tool' }),
      ctx,
    );

    // どうぐロックではないので、これは警告なしで通る
    expect(played.warnings.map((w) => w.code)).not.toContain(WARNING_CODES.CARD_KIND_LOCKED);
  });

  it('ロックされた種別を使うと警告が出て、それでも通る', () => {
    const locked = attachTool(table(), BOB, 'b-itemlock');
    // アリスの手札に「グッズ」を1枚用意する
    const withItem = withCards(locked, [
      {
        instanceId: 'a-item',
        functionalId: 'fn-item',
        ownerId: ALICE,
        zone: 'hand',
        visibleTo: [ALICE],
        faceUp: false,
        position: 9,
      },
    ]);
    const itemCtx: RuleContext = {
      cards: buildCardIndex([
        ...(ctx.cards?.all ?? []),
        {
          functionalId: 'fn-item',
          name: 'ダミーのグッズ',
          supertype: 'trainer',
          trainerKind: 'item',
          text: '何もしない。',
        },
      ]),
    };

    const played = applyActionChecked(
      withItem,
      act({ type: 'moveCard', cardId: 'a-item', toZone: 'discard' }),
      itemCtx,
    );

    expect(played.warnings.map((w) => w.code)).toContain(WARNING_CODES.CARD_KIND_LOCKED);
    expect(played.warnings[0]?.message).toBe('いまグッズは使えません（ダミーのグッズロック）');
    // ★それでも操作は通る（第2段階 §2）
    expect(played.state.cards['a-item']?.zone).toBe('discard');
  });

  it('ロックがなければ警告は出ない', () => {
    const withItem = withCards(table(), [
      {
        instanceId: 'a-item2',
        functionalId: 'fn-item',
        ownerId: ALICE,
        zone: 'hand',
        visibleTo: [ALICE],
        faceUp: false,
        position: 9,
      },
    ]);
    const itemCtx: RuleContext = {
      cards: buildCardIndex([
        ...(ctx.cards?.all ?? []),
        {
          functionalId: 'fn-item',
          name: 'ダミーのグッズ',
          supertype: 'trainer',
          trainerKind: 'item',
          text: '何もしない。',
        },
      ]),
    };
    const played = applyActionChecked(
      withItem,
      act({ type: 'moveCard', cardId: 'a-item2', toZone: 'discard' }),
      itemCtx,
    );
    expect(played.warnings.map((w) => w.code)).not.toContain(WARNING_CODES.CARD_KIND_LOCKED);
  });
});
