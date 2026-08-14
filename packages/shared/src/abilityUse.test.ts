/**
 * T34 の仕組みそのもの:
 *   1. ★「自分の番に1回」は **CardInstance 単位** で数える
 *   2. 数え方は「使った番の番号」。0に戻す処理をどこにも書かない
 *   3. draw の upToHandSize / discard の lookAt
 */
import { describe, expect, it } from 'vitest';
import { applyAction, applyActions, type Action } from './actions';
import { buildCardIndex } from './cards';
import { cardsInZone, createGameState, withCards } from './gameState';
import { abilityUseKey, canUseAbilityThisTurn } from './derived';
import { canStep } from './interpreter';
import { WARNING_CODES, type RuleContext } from './rules';
import type { EffectSource, Op } from './dsl';
import { ALICE, BOB, tick } from './testFixtures';
import type { CardInstance, CardText, GameState, PlayerId } from './types';

const act = <T extends Omit<Action, 'actorId' | 'at'>>(a: T, actorId: PlayerId = ALICE): Action =>
  ({ ...a, actorId, at: tick() }) as Action;

// ── カード定義 ────────────────────────

const DRAW_ABILITY: Op[] = [{ op: 'draw', player: 'self', count: 1 }];

const SYSTEM_MON: CardText = {
  functionalId: 'fn-system',
  name: 'デデンネもどき',
  supertype: 'pokemon',
  hp: 90,
  types: ['lightning'],
  stage: 'basic',
  ruleBox: null,
  attacks: [],
  weakness: null,
  resistance: null,
  retreatCost: 1,
  abilities: [
    {
      name: 'テストチェンジ',
      kind: 'ability',
      text: '自分の番に1回使える。',
      oncePerTurn: true,
      effects: DRAW_ABILITY,
    },
  ],
};

const PLAIN: CardText = { ...SYSTEM_MON, functionalId: 'fn-plain', name: 'ゼニガメ', abilities: [] };

const ctx: RuleContext = { cards: buildCardIndex([SYSTEM_MON, PLAIN]) };

const card = (instanceId: string, fid: string, position: number): CardInstance => ({
  instanceId,
  functionalId: fid,
  ownerId: ALICE,
  zone: 'deck',
  visibleTo: [],
  faceUp: false,
  position,
});

/** アリスの場に同じシステムポケモンを2匹、山札に10枚 */
function table(): GameState {
  const base = createGameState({
    gameId: 'g-ability',
    rngSeed: 'seed',
    seats: [
      { playerId: ALICE, displayName: 'アリス' },
      { playerId: BOB, displayName: 'ボブ' },
    ],
  });
  const cards: CardInstance[] = [
    card('a-active', 'fn-plain', 0),
    card('a-sys1', 'fn-system', 1),
    card('a-sys2', 'fn-system', 2),
  ];
  for (let i = 0; i < 10; i += 1) cards.push(card(`a-deck-${i}`, 'fn-plain', 10 + i));

  return applyActions(
    withCards({ ...base, phase: 'turn', turn: 3, setup: null }, cards),
    [
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-active' }),
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'bench-0', cardId: 'a-sys1' }),
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'bench-1', cardId: 'a-sys2' }),
    ],
    ctx,
  );
}

/** その実体の特性を使う（＝ startEffect を abilityIndex つきで積む） */
const useAbility = (state: GameState, instanceId: string, ops: Op[] = DRAW_ABILITY): GameState => {
  const source: EffectSource = {
    instanceId,
    playerId: ALICE,
    label: 'テストチェンジ',
    abilityIndex: 0,
  };
  return applyAction(
    state,
    act({ type: 'startEffect', executionId: `x-${instanceId}-${tick()}`, ops, source }),
    ctx,
  );
};

const runToEnd = (state: GameState): GameState => {
  let current = state;
  for (let i = 0; i < 20 && canStep(current); i += 1) {
    current = applyAction(
      current,
      act({ type: 'effectStep', executionId: current.execution!.executionId }),
      ctx,
    );
  }
  return current;
};

const lastWarnings = (state: GameState): string[] =>
  (state.log[state.log.length - 1]?.warnings ?? []).map((w) => w.code);

// ── ★CardInstance 単位 ────────────────

describe('★「自分の番に1回」はカードの実体ごとに数える', () => {
  it('キーは instanceId と特性番号の組', () => {
    expect(abilityUseKey('a-sys1', 0)).toBe('a-sys1#0');
    expect(abilityUseKey('a-sys1', 0)).not.toBe(abilityUseKey('a-sys2', 0));
  });

  it('使う前は両方とも使える', () => {
    const state = table();
    expect(canUseAbilityThisTurn(state, 'a-sys1', 0)).toBe(true);
    expect(canUseAbilityThisTurn(state, 'a-sys2', 0)).toBe(true);
  });

  it('★1匹目を使っても、2匹目は使える', () => {
    const used = runToEnd(useAbility(table(), 'a-sys1'));
    expect(canUseAbilityThisTurn(used, 'a-sys1', 0)).toBe(false);
    expect(canUseAbilityThisTurn(used, 'a-sys2', 0)).toBe(true);
  });

  it('★同じ実体の2回目は警告が出る。ただし操作は通る', () => {
    const once = runToEnd(useAbility(table(), 'a-sys1'));
    const handAfterOnce = cardsInZone(once, ALICE, 'hand').length;

    const twice = runToEnd(useAbility(once, 'a-sys1'));
    // 警告は startEffect の行に載る
    const startWarnings = twice.log
      .filter((entry) => entry.action.type === 'startEffect')
      .flatMap((entry) => entry.warnings.map((w) => w.code));
    expect(startWarnings).toContain(WARNING_CODES.ABILITY_ALREADY_USED);
    // ★止めていない。2回目もちゃんと引けている
    expect(cardsInZone(twice, ALICE, 'hand').length).toBe(handAfterOnce + 1);
  });

  it('2匹目を使ったときは警告が出ない', () => {
    const first = runToEnd(useAbility(table(), 'a-sys1'));
    const second = runToEnd(useAbility(first, 'a-sys2'));
    expect(lastWarnings(second)).not.toContain(WARNING_CODES.ABILITY_ALREADY_USED);
  });

  it('特性でない効果（abilityIndex なし）は記録しない', () => {
    const state = applyAction(
      table(),
      act({
        type: 'startEffect',
        executionId: 'x-item',
        ops: DRAW_ABILITY,
        source: { instanceId: 'a-sys1', playerId: ALICE, label: 'グッズ' },
      }),
      ctx,
    );
    expect(state.abilityUses).toEqual({});
  });
});

describe('★数え方は「使った番の番号」', () => {
  it('番が変われば、また使えるようになる', () => {
    const used = runToEnd(useAbility(table(), 'a-sys1'));
    expect(used.abilityUses['a-sys1#0']).toBe(3);
    expect(canUseAbilityThisTurn(used, 'a-sys1', 0)).toBe(false);

    // ★カウンタを0に戻す処理はどこにもない。番の番号が変われば使える
    const nextTurn: GameState = { ...used, turn: 4 };
    expect(canUseAbilityThisTurn(nextTurn, 'a-sys1', 0)).toBe(true);
    // 記録自体は残る（いつ使ったかを追える）
    expect(nextTurn.abilityUses['a-sys1#0']).toBe(3);
  });
});

// ── draw の upToHandSize / discard の lookAt ──

describe('draw upToHandSize', () => {
  const draw = (state: GameState, upToHandSize: number): GameState =>
    runToEnd(
      useAbility(state, 'a-sys1', [{ op: 'draw', player: 'self', count: 0, upToHandSize }]),
    );

  it('手札がその枚数になるまで引く', () => {
    const state = draw(table(), 6);
    expect(cardsInZone(state, ALICE, 'hand')).toHaveLength(6);
  });

  it('★すでに足りていれば1枚も引かない', () => {
    const seven = draw(table(), 7);
    const deckBefore = cardsInZone(seven, ALICE, 'deck').length;
    const again = draw(seven, 6);
    expect(cardsInZone(again, ALICE, 'hand')).toHaveLength(7);
    expect(cardsInZone(again, ALICE, 'deck')).toHaveLength(deckBefore);
  });

  it('山札が足りなければ、あるだけ引く', () => {
    const state = draw(table(), 99);
    expect(cardsInZone(state, ALICE, 'deck')).toHaveLength(0);
    expect(cardsInZone(state, ALICE, 'hand')).toHaveLength(10);
  });
});

describe('discard lookAt', () => {
  it('★山札の上から指定枚数だけを対象にする', () => {
    const before = cardsInZone(table(), ALICE, 'deck').map((c) => c.instanceId);
    const state = runToEnd(
      useAbility(table(), 'a-sys1', [
        { op: 'discard', from: 'deck', owner: 'self', count: 2, chooser: 'self', lookAt: 2 },
      ]),
    );
    // 選ぶ余地がないので聞かずに落ちる
    expect(state.execution).toBeNull();
    expect(state.cards[before[0]!]?.zone).toBe('discard');
    expect(state.cards[before[1]!]?.zone).toBe('discard');
    expect(state.cards[before[2]!]?.zone).toBe('deck');
  });

  it('lookAt がなければ山札全体が対象（選ばせる）', () => {
    const state = useAbility(table(), 'a-sys1', [
      { op: 'discard', from: 'deck', owner: 'self', count: 2, chooser: 'self' },
    ]);
    const stepped = applyAction(
      state,
      act({ type: 'effectStep', executionId: state.execution!.executionId }),
      ctx,
    );
    expect(stepped.execution?.pendingChoice?.candidates).toHaveLength(10);
  });
});
