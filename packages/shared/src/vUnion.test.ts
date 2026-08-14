/**
 * T38 の完了条件:
 *   「トラッシュに4種揃うと組み立てUIが出て、ベンチに出せる」
 *
 * ここでは仕組み側を確かめる:
 *   - トラッシュの V-UNION を名前ごとにまとめ、何番が足りないかを出す
 *   - 4枚を1つのスタックに積んでベンチに出す
 *   - 組み上がったら4枚ぶんのワザが使え、HPは1匹ぶん
 *   - ★対戦中1回・プレイヤー単位
 *   - きぜつでサイド3枚（T36 の表）
 */
import { describe, expect, it } from 'vitest';
import { applyAction, applyActions, type Action } from './actions';
import { buildCardIndex } from './cards';
import { createGameState, withCards } from './gameState';
import { effectiveProfileOf, getEffectiveAttacks, getEffectiveHp } from './effectiveCard';
import { effectSlotKey } from './effects';
import { prizesForRuleBox } from './knockout';
import { hasUsedOncePerGame } from './ruleBox';
import { WARNING_CODES, type RuleContext } from './rules';
import { checkVUnionAssembly, isVUnionCard, vUnionGroupsInDiscard } from './vUnion';
import { ALICE, BOB, tick } from './testFixtures';
import type { CardInstance, CardText, GameState, PlayerId } from './types';

const act = <T extends Omit<Action, 'actorId' | 'at'>>(a: T, actorId: PlayerId = ALICE): Action =>
  ({ ...a, actorId, at: tick() }) as Action;

// ── カード定義（4枚で1匹） ────────────────

/** ★4枚とも同じ name。functionalId と vUnionPart で区別する */
const part = (n: number, over: Partial<CardText> = {}): CardText => ({
  functionalId: `fn-vu-${n}`,
  name: 'ミュウツーV-UNION',
  supertype: 'pokemon',
  hp: 320,
  types: ['psychic'],
  stage: 'vunion',
  ruleBox: 'VUNION',
  vUnionPart: n,
  attacks: [],
  weakness: null,
  resistance: null,
  retreatCost: 2,
  ...over,
});

const PARTS: CardText[] = [
  part(1, { weakness: { type: 'darkness', modifier: '×2' }, retreatCost: 2 }),
  part(2, { attacks: [{ name: 'サイコジャンプ', cost: ['psychic'], damage: '50', text: '' }] }),
  part(3, { attacks: [{ name: 'メガバーン', cost: ['psychic', 'psychic'], damage: '160', text: '' }] }),
  part(4, {
    abilities: [{ name: 'V-UNIONの特性', kind: 'ability', text: 'テスト' }],
  }),
];

/** 別の V-UNION（名前が違えば別の組） */
const OTHER = part(1, { functionalId: 'fn-other-1', name: 'ゲンガーV-UNION' });

const PLAIN: CardText = {
  functionalId: 'fn-plain',
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

const ctx: RuleContext = { cards: buildCardIndex([...PARTS, OTHER, PLAIN]) };

const card = (instanceId: string, fid: string, ownerId: PlayerId = ALICE): CardInstance => ({
  instanceId,
  functionalId: fid,
  ownerId,
  zone: 'deck',
  visibleTo: [],
  faceUp: false,
});

/** アリスのバトル場にゼニガメ。`inDiscard` の番号だけトラッシュに置く */
function table(inDiscard: readonly number[]): GameState {
  const base = createGameState({
    gameId: 'g-vunion',
    rngSeed: 'seed',
    seats: [
      { playerId: ALICE, displayName: 'アリス' },
      { playerId: BOB, displayName: 'ボブ' },
    ],
  });
  const cards = [
    card('a-plain', 'fn-plain'),
    card('b-plain', 'fn-plain', BOB),
    ...PARTS.map((p, i) => card(`a-vu-${i + 1}`, p.functionalId)),
    card('a-other', OTHER.functionalId),
  ];
  const actions: Action[] = [
    act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-plain' }),
    act({ type: 'placePokemon', playerId: BOB, slotId: 'active', cardId: 'b-plain' }, BOB),
    ...inDiscard.map((n) => act({ type: 'moveCard', cardId: `a-vu-${n}`, toZone: 'discard' })),
  ];
  return applyActions(
    withCards({ ...base, phase: 'turn', turn: 3, setup: null }, cards),
    actions,
    ctx,
  );
}

const assemble = (state: GameState, ids: string[] = ['a-vu-1', 'a-vu-2', 'a-vu-3', 'a-vu-4']) =>
  applyAction(
    state,
    act({ type: 'assembleVUnion', playerId: ALICE, slotId: 'bench-0', cardIds: ids }),
    ctx,
  );

const lastWarnings = (state: GameState): string[] =>
  (state.log[state.log.length - 1]?.warnings ?? []).map((w) => w.code);

const KEY = effectSlotKey(ALICE, 'bench-0');

// ── トラッシュの集計 ───────────────────

describe('トラッシュの V-UNION をまとめる', () => {
  it('V-UNION かどうかを見分けられる', () => {
    expect(isVUnionCard(PARTS[0])).toBe(true);
    expect(isVUnionCard(PLAIN)).toBe(false);
  });

  it('トラッシュになければ何も返さない', () => {
    expect(vUnionGroupsInDiscard(table([]), ALICE, ctx)).toEqual([]);
  });

  it('★足りない番号が分かる', () => {
    const groups = vUnionGroupsInDiscard(table([1, 3]), ALICE, ctx);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      name: 'ミュウツーV-UNION',
      missing: [2, 4],
      complete: false,
    });
    expect(groups[0]?.parts.map((p) => p.part)).toEqual([1, 3]);
  });

  it('4種そろえば complete', () => {
    const groups = vUnionGroupsInDiscard(table([1, 2, 3, 4]), ALICE, ctx);
    expect(groups[0]?.complete).toBe(true);
    expect(groups[0]?.missing).toEqual([]);
  });

  it('名前が違えば別の組として数える', () => {
    const state = applyAction(
      table([1]),
      act({ type: 'moveCard', cardId: 'a-other', toZone: 'discard' }),
      ctx,
    );
    expect(vUnionGroupsInDiscard(state, ALICE, ctx).map((g) => g.name)).toEqual([
      'ゲンガーV-UNION',
      'ミュウツーV-UNION',
    ]);
  });

  it('相手のトラッシュは数えない', () => {
    expect(vUnionGroupsInDiscard(table([1, 2, 3, 4]), BOB, ctx)).toEqual([]);
  });
});

// ── 出せるかどうかの判定 ────────────────

describe('★出せるかどうか（理由つき）', () => {
  const groupOf = (nums: number[]) => vUnionGroupsInDiscard(table(nums), ALICE, ctx)[0];

  it('4種そろい、ベンチが空いていて、まだ使っていなければ出せる', () => {
    expect(checkVUnionAssembly(groupOf([1, 2, 3, 4]), false, true)).toEqual({
      ready: true,
      reason: null,
    });
  });

  it('★足りないときは「何番が」だけ言い、どこにあるかは言わない', () => {
    const result = checkVUnionAssembly(groupOf([1, 3]), false, true);
    expect(result.ready).toBe(false);
    expect(result.reason).toContain('2・4枚目');
    // ★サイドの中身を推測させない言い方になっている
    expect(result.reason).toContain('山札かサイド');
  });

  it('もう組み立てていれば出せない', () => {
    expect(checkVUnionAssembly(groupOf([1, 2, 3, 4]), true, true).reason).toContain(
      'すでに組み立てています',
    );
  });

  it('ベンチが空いていなければ出せない', () => {
    expect(checkVUnionAssembly(groupOf([1, 2, 3, 4]), false, false).reason).toContain('ベンチ');
  });
});

// ── ★組み立て ────────────────────────

describe('★4枚を1つのスタックに積んでベンチに出す', () => {
  const state = assemble(table([1, 2, 3, 4]));
  const slot = state.players[ALICE]!.pokemon.find((p) => p.slotId === 'bench-0');

  it('4枚が1匹ぶんのスタックになる', () => {
    expect(slot?.stack).toEqual(['a-vu-1', 'a-vu-2', 'a-vu-3', 'a-vu-4']);
    expect(state.players[ALICE]!.pokemon).toHaveLength(2);
  });

  it('4枚ともベンチのゾーンに移り、両者に見える', () => {
    for (const id of slot!.stack) {
      expect(state.cards[id]?.zone).toBe('bench');
      expect(state.cards[id]?.visibleTo).toEqual([ALICE, BOB]);
    }
  });

  it('進化ではないので進化まわりの記録は立てない', () => {
    expect(slot?.evolvedOnTurn).toBeNull();
    expect(slot?.placedOnTurn).toBe(3);
  });

  it('★4枚ぶんのワザが使える', () => {
    expect(getEffectiveAttacks(state, KEY, ctx).map((a) => a.name)).toEqual([
      'サイコジャンプ',
      'メガバーン',
    ]);
  });

  it('★HPは1匹ぶん（320）', () => {
    expect(getEffectiveHp(state, KEY, ctx)).toBe(320);
  });

  it('弱点・にげるは印刷されている1枚から採る', () => {
    const profile = effectiveProfileOf(state, ALICE, 'bench-0', ctx);
    expect(profile.isVUnion).toBe(true);
    // ★BREAK ではないので、横向き表示にはしない
    expect(profile.isBreak).toBe(false);
    expect(profile.weakness).toEqual({ type: 'darkness', modifier: '×2' });
    expect(profile.retreatCost).toBe(2);
  });

  it('特性も4枚ぶんから集まる', () => {
    const profile = effectiveProfileOf(state, ALICE, 'bench-0', ctx);
    expect(profile.abilities.map((entry) => entry.ability.name)).toEqual(['V-UNIONの特性']);
    expect(profile.abilities[0]?.from.instanceId).toBe('a-vu-4');
  });
});

// ── ★対戦中1回 ───────────────────────

describe('★組み立ては対戦中1回・プレイヤー単位', () => {
  it('組み立てると枠が埋まる', () => {
    const state = assemble(table([1, 2, 3, 4]));
    expect(hasUsedOncePerGame(state, ALICE, 'vunion')).toBe(true);
    expect(hasUsedOncePerGame(state, BOB, 'vunion')).toBe(false);
    expect(lastWarnings(state)).not.toContain(WARNING_CODES.ONCE_PER_GAME_USED);
  });

  it('★2回目は警告が出る。ただし止めない', () => {
    const once = assemble(table([1, 2, 3, 4]));
    const removed = applyAction(
      once,
      act({ type: 'removePokemon', playerId: ALICE, slotId: 'bench-0', toZone: 'discard' }),
      ctx,
    );
    const twice = assemble(removed);
    expect(lastWarnings(twice)).toContain(WARNING_CODES.ONCE_PER_GAME_USED);
    // ★通っている
    expect(twice.players[ALICE]!.pokemon.some((p) => p.slotId === 'bench-0')).toBe(true);
  });

  it('番が変わっても戻らない', () => {
    const state = applyAction(assemble(table([1, 2, 3, 4])), act({ type: 'endTurn' }), ctx);
    expect(hasUsedOncePerGame(state, ALICE, 'vunion')).toBe(true);
  });

  it('★4枚に足りなくても止めない。警告して通す', () => {
    const state = assemble(table([1, 2]), ['a-vu-1', 'a-vu-2']);
    expect(lastWarnings(state)).toContain(WARNING_CODES.VUNION_INCOMPLETE);
    expect(state.players[ALICE]!.pokemon.some((p) => p.slotId === 'bench-0')).toBe(true);
  });
});

// ── きぜつ ─────────────────────────

describe('きぜつ', () => {
  it('★サイドは3枚（T36 の表）', () => {
    expect(prizesForRuleBox('VUNION')).toBe(3);
  });

  it('きぜつすると4枚まとめてトラッシュへ', () => {
    const state = assemble(table([1, 2, 3, 4]));
    const knocked = applyAction(
      state,
      act({
        type: 'knockOut',
        playerId: ALICE,
        slotId: 'bench-0',
        expectedTopInstanceId: 'a-vu-4',
        prizePlayerId: BOB,
        prizeCount: 3,
        prizeCardIds: [],
      }),
      ctx,
    );
    for (const id of ['a-vu-1', 'a-vu-2', 'a-vu-3', 'a-vu-4']) {
      expect(knocked.cards[id]?.zone).toBe('discard');
    }
    expect(knocked.players[ALICE]!.pokemon.some((p) => p.slotId === 'bench-0')).toBe(false);
  });
});
