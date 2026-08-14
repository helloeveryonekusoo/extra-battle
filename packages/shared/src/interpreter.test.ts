/**
 * T24 の完了条件:
 *   1. `draw` `shuffle` `discard` の3つだけで動くテストが通る
 *   2. ★実行途中の EffectExecution を JSON化 → 復元しても続きから実行できる
 */
import { describe, expect, it } from 'vitest';
import { applyAction, applyActions, type Action } from './actions';
import { buildCardIndex } from './cards';
import { cardsInZone, createGameState, withCards } from './gameState';
import {
  canStep,
  createExecution,
  currentOp,
  flattenOps,
  MAX_EXPANDED_OPS,
  stepEffect,
  EffectError,
  type EffectRolls,
} from './interpreter';
import type { EffectSource, Op } from './dsl';
import type { RuleContext } from './rules';
import { ALICE, BOB, tick } from './testFixtures';
import type { CardInstance, CardText, GameState, PlayerId } from './types';

const act = <T extends Omit<Action, 'actorId' | 'at'>>(a: T, actorId: PlayerId = ALICE): Action =>
  ({ ...a, actorId, at: tick() }) as Action;

// ── 卓の用意 ───────────────────────────

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
const ENERGY: CardText = {
  functionalId: 'fn-water',
  name: '基本水エネルギー',
  supertype: 'energy',
  isBasicEnergy: true,
  energyProvides: ['water'],
};
const ITEM: CardText = {
  functionalId: 'fn-item',
  name: 'クイックボール',
  supertype: 'trainer',
  trainerKind: 'item',
  text: '手札を1枚トラッシュ。山札からたねポケモンを1枚。',
};

const ctx: RuleContext = { cards: buildCardIndex([BASIC, ENERGY, ITEM]) };

const SOURCE: EffectSource = {
  instanceId: null,
  playerId: ALICE,
  label: 'テストのカード',
};

/** アリスの山札10枚（ゼニガメ・水エネ・グッズが順に並ぶ） と 手札4枚 */
function makeTable(): GameState {
  const base = createGameState({
    gameId: 'g-effect',
    rngSeed: 'seed',
    seats: [
      { playerId: ALICE, displayName: 'アリス' },
      { playerId: BOB, displayName: 'ボブ' },
    ],
  });

  const cards: CardInstance[] = [];
  const FIDS = ['fn-basic', 'fn-water', 'fn-item'];
  for (let i = 0; i < 10; i += 1) {
    cards.push({
      instanceId: `a-deck-${i}`,
      functionalId: FIDS[i % 3] as string,
      ownerId: ALICE,
      zone: 'deck',
      visibleTo: [],
      faceUp: false,
      position: i,
    });
  }
  for (let i = 0; i < 4; i += 1) {
    cards.push({
      instanceId: `a-hand-${i}`,
      // 手札は ゼニガメ / 水エネ / グッズ / ゼニガメ
      functionalId: (i === 1 ? 'fn-water' : i === 2 ? 'fn-item' : 'fn-basic') as string,
      ownerId: ALICE,
      zone: 'hand',
      visibleTo: [ALICE],
      faceUp: false,
      position: i,
    });
  }
  for (let i = 0; i < 5; i += 1) {
    cards.push({
      instanceId: `b-deck-${i}`,
      functionalId: 'fn-basic',
      ownerId: BOB,
      zone: 'deck',
      visibleTo: [],
      faceUp: false,
      position: i,
    });
  }

  return withCards({ ...base, phase: 'turn', turn: 3, setup: null }, cards);
}

/** 効果を開始した状態を作る */
function started(state: GameState, ops: Op[]): GameState {
  return applyAction(
    state,
    act({ type: 'startEffect', executionId: 'x1', ops, source: SOURCE }),
    ctx,
  );
}

/** 応答待ちになるか終わるまで回す。1回の呼び出しで1オペコードずつ */
function runToEnd(state: GameState, rolls: EffectRolls = {}, limit = 50): GameState {
  let current = state;
  for (let i = 0; i < limit && canStep(current); i += 1) {
    current = applyAction(
      current,
      act({ type: 'effectStep', executionId: 'x1', rolls }),
      ctx,
    );
  }
  return current;
}

const zoneOf = (state: GameState, owner: PlayerId, zone: 'deck' | 'hand' | 'discard') =>
  cardsInZone(state, owner, zone).map((c) => c.instanceId);

// ── 完了条件 1: draw / shuffle / discard ──

describe('★draw / shuffle / discard だけで動く', () => {
  it('draw: 山札の上から手札へ移る', () => {
    const state = runToEnd(started(makeTable(), [{ op: 'draw', player: 'self', count: 3 }]));

    expect(zoneOf(state, ALICE, 'hand')).toEqual([
      'a-hand-0',
      'a-hand-1',
      'a-hand-2',
      'a-hand-3',
      'a-deck-0',
      'a-deck-1',
      'a-deck-2',
    ]);
    expect(zoneOf(state, ALICE, 'deck')).toHaveLength(7);
    // 引いたカードは自分にだけ見える
    expect(state.cards['a-deck-0']?.visibleTo).toEqual([ALICE]);
    // 実行は畳まれている
    expect(state.execution).toBeNull();
  });

  it('draw: player: "both" は両者が引く', () => {
    const state = runToEnd(started(makeTable(), [{ op: 'draw', player: 'both', count: 2 }]));
    expect(zoneOf(state, ALICE, 'hand')).toHaveLength(6);
    expect(zoneOf(state, BOB, 'hand')).toHaveLength(2);
  });

  it('draw: 山札より多く引こうとしても、あるだけ引いて落ちない', () => {
    const state = runToEnd(started(makeTable(), [{ op: 'draw', player: 'self', count: 99 }]));
    expect(zoneOf(state, ALICE, 'deck')).toEqual([]);
    expect(zoneOf(state, ALICE, 'hand')).toHaveLength(14);
  });

  it('shuffle: サーバーが決めた並びをそのまま使う（自分では乱数を振らない）', () => {
    const order = ['a-deck-4', 'a-deck-0', 'a-deck-9', 'a-deck-1', 'a-deck-2',
      'a-deck-3', 'a-deck-5', 'a-deck-6', 'a-deck-7', 'a-deck-8'];
    const state = runToEnd(
      started(makeTable(), [{ op: 'shuffle', zone: 'deck', owner: 'self' }]),
      { order },
    );
    expect(zoneOf(state, ALICE, 'deck')).toEqual(order);
  });

  it('shuffle: 並びが渡されなければ黙って通さない', () => {
    expect(() => runToEnd(started(makeTable(), [{ op: 'shuffle', zone: 'deck', owner: 'self' }])))
      .toThrow(/シャッフルの並び/);
  });

  it('discard: count "all" は手札を全部トラッシュへ（博士の研究）', () => {
    const state = runToEnd(
      started(makeTable(), [
        { op: 'discard', from: 'hand', owner: 'self', count: 'all', chooser: 'self' },
        { op: 'draw', player: 'self', count: 7 },
      ]),
    );
    expect(zoneOf(state, ALICE, 'discard')).toHaveLength(4);
    expect(zoneOf(state, ALICE, 'hand')).toHaveLength(7);
  });

  it('discard: filter で絞れる（手札の水エネだけ）', () => {
    const state = runToEnd(
      started(makeTable(), [
        {
          op: 'discard',
          from: 'hand',
          owner: 'self',
          filter: { isBasicEnergy: true },
          count: 'all',
          chooser: 'self',
        },
      ]),
    );
    expect(zoneOf(state, ALICE, 'discard')).toEqual(['a-hand-1']);
    expect(zoneOf(state, ALICE, 'hand')).toHaveLength(3);
  });

  it('discard: 選ぶ余地があるときは人に聞く（勝手に選ばない）', () => {
    const state = runToEnd(
      started(makeTable(), [
        { op: 'discard', from: 'hand', owner: 'self', count: 1, chooser: 'self' },
      ]),
    );
    const choice = state.execution?.pendingChoice;
    expect(choice?.kind).toBe('selectCards');
    expect(choice?.chooser).toBe(ALICE);
    expect(choice?.candidates).toHaveLength(4);
    expect(choice?.min).toBe(1);
    // まだ何もトラッシュされていない
    expect(zoneOf(state, ALICE, 'discard')).toEqual([]);
  });

  it('discard: 候補が枚数以下なら聞かずに実行する', () => {
    const state = runToEnd(
      started(makeTable(), [
        {
          op: 'discard',
          from: 'hand',
          owner: 'self',
          filter: { isBasicEnergy: true },
          count: 3,
          chooser: 'self',
        },
      ]),
    );
    expect(state.execution).toBeNull();
    expect(zoneOf(state, ALICE, 'discard')).toEqual(['a-hand-1']);
  });
});

// ── 完了条件 2: JSON 化して復元 ──

describe('★実行途中を JSON 化 → 復元しても続きから実行できる', () => {
  const ops: Op[] = [
    { op: 'draw', player: 'self', count: 1 },
    { op: 'draw', player: 'self', count: 1 },
    { op: 'discard', from: 'hand', owner: 'self', count: 'all', chooser: 'self' },
    { op: 'draw', player: 'self', count: 5 },
  ];

  /** 1歩だけ進める */
  const oneStep = (state: GameState): GameState =>
    applyAction(state, act({ type: 'effectStep', executionId: 'x1', rolls: {} }), ctx);

  it('途中で保存 → 復元 → 続きを実行した結果が、通しで実行した結果と一致する', () => {
    const start = started(makeTable(), ops);

    // 通しで実行
    const straight = runToEnd(start);

    // 2歩進めて保存 → 復元 → 続き
    let paused = oneStep(oneStep(start));
    expect(paused.execution?.cursor).toBe(2);

    const saved = JSON.stringify(paused);
    const restored: GameState = JSON.parse(saved) as GameState;
    // ★ジェネレータではなくデータなので、そのまま戻ってくる
    expect(restored.execution).toEqual(paused.execution);

    paused = runToEnd(restored);

    expect(zoneOf(paused, ALICE, 'hand')).toEqual(zoneOf(straight, ALICE, 'hand'));
    expect(zoneOf(paused, ALICE, 'deck')).toEqual(zoneOf(straight, ALICE, 'deck'));
    expect(zoneOf(paused, ALICE, 'discard')).toEqual(zoneOf(straight, ALICE, 'discard'));
    expect(paused.execution).toBeNull();
  });

  it('応答待ちのまま保存しても、待っている内容がそのまま戻る', () => {
    const start = started(makeTable(), [
      { op: 'discard', from: 'hand', owner: 'self', count: 2, chooser: 'self' },
    ]);
    const waiting = runToEnd(start);
    const restored: GameState = JSON.parse(JSON.stringify(waiting)) as GameState;

    expect(restored.execution?.pendingChoice).toEqual(waiting.execution?.pendingChoice);
    // 応答待ちの間は進めない（§3.3）
    expect(canStep(restored)).toBe(false);
    expect(restored).toEqual(waiting);
  });

  it('実行状態は JSON で表せるものだけでできている', () => {
    const state = oneStep(started(makeTable(), ops));
    expect(JSON.parse(JSON.stringify(state.execution))).toEqual(state.execution);
  });
});

// ── 1回で1オペコード ──

describe('1回の呼び出しで1オペコードだけ進む', () => {
  it('cursor が1ずつ進む', () => {
    let state = started(makeTable(), [
      { op: 'draw', player: 'self', count: 1 },
      { op: 'draw', player: 'self', count: 1 },
      { op: 'draw', player: 'self', count: 1 },
    ]);
    expect(state.execution?.cursor).toBe(0);

    for (const expected of [1, 2]) {
      state = applyAction(state, act({ type: 'effectStep', executionId: 'x1' }), ctx);
      expect(state.execution?.cursor).toBe(expected);
      expect(zoneOf(state, ALICE, 'hand')).toHaveLength(4 + expected);
    }

    // 最後の1歩で実行が畳まれる
    state = applyAction(state, act({ type: 'effectStep', executionId: 'x1' }), ctx);
    expect(state.execution).toBeNull();
  });

  it('別の実行に対する effectStep は何もしない', () => {
    const state = started(makeTable(), [{ op: 'draw', player: 'self', count: 1 }]);
    const after = applyAction(state, act({ type: 'effectStep', executionId: 'x-other' }), ctx);
    expect(after.execution?.cursor).toBe(0);
    expect(zoneOf(after, ALICE, 'hand')).toHaveLength(4);
  });

  it('stepEffect は渡された state を書き換えない', () => {
    const state = started(makeTable(), [{ op: 'draw', player: 'self', count: 1 }]);
    const before = JSON.stringify(state);
    stepEffect(state, {}, ctx);
    expect(JSON.stringify(state)).toBe(before);
  });
});

// ── if / repeat のフラット化 ──

describe('if / repeat は ops をフラット化して cursor で扱う（再帰しない）', () => {
  it('回数がリテラルの repeat は実行前に展開される', () => {
    const flat = flattenOps([
      { op: 'repeat', times: 3, body: [{ op: 'draw', player: 'self', count: 1 }] },
    ]);
    expect(flat).toHaveLength(3);
    expect(flat.every((o) => o.op === 'draw')).toBe(true);
  });

  it('入れ子の repeat も展開される', () => {
    const flat = flattenOps([
      {
        op: 'repeat',
        times: 2,
        body: [{ op: 'repeat', times: 3, body: [{ op: 'draw', player: 'self', count: 1 }] }],
      },
    ]);
    expect(flat).toHaveLength(6);
  });

  it('if は実行時に、通った枝だけを cursor の直後へ差し込む', () => {
    const ops: Op[] = [
      {
        op: 'if',
        cond: { kind: 'count', of: { source: 'zone', zone: 'hand', owner: 'self' }, compare: 'gte', value: 4 },
        then: [{ op: 'draw', player: 'self', count: 2 }],
        else: [{ op: 'draw', player: 'self', count: 99 }],
      },
    ];
    let state = started(makeTable(), ops);
    expect(state.execution?.ops).toHaveLength(1);

    // if を1歩ぶん処理すると、then の中身が差し込まれる
    state = applyAction(state, act({ type: 'effectStep', executionId: 'x1' }), ctx);
    expect(state.execution?.ops).toHaveLength(2);
    expect(state.execution?.cursor).toBe(1);
    expect(currentOp(state.execution)?.op).toBe('draw');

    state = runToEnd(state);
    expect(zoneOf(state, ALICE, 'hand')).toHaveLength(6);
  });

  it('条件が偽なら else 側が差し込まれる。else がなければ何も入らない', () => {
    const state = runToEnd(
      started(makeTable(), [
        {
          op: 'if',
          cond: { kind: 'count', of: { source: 'prizes', player: 'self' }, compare: 'eq', value: 0 },
          then: [{ op: 'draw', player: 'self', count: 5 }],
        },
      ]),
    );
    expect(zoneOf(state, ALICE, 'hand')).toHaveLength(4);
    expect(state.execution).toBeNull();
  });

  it('回数が bindings 由来の repeat は実行時に展開する', () => {
    const state = runToEnd(
      applyAction(
        makeTable(),
        act({
          type: 'startEffect',
          executionId: 'x1',
          ops: [{ op: 'repeat', times: { binding: 'n' }, body: [{ op: 'draw', player: 'self', count: 1 }] }],
          source: SOURCE,
        }),
        ctx,
      ),
    );
    // binding が未設定なら0回。落ちない
    expect(zoneOf(state, ALICE, 'hand')).toHaveLength(4);
  });

  it('展開が大きくなりすぎたら止める（無限ループの歯止め）', () => {
    expect(() =>
      flattenOps([
        { op: 'repeat', times: 10_000, body: [{ op: 'draw', player: 'self', count: 1 }] },
      ]),
    ).toThrow(EffectError);
    expect(MAX_EXPANDED_OPS).toBeGreaterThan(0);
  });
});

// ── 逃げ道 ──

describe('自動化していないところは人間に投げる（§7-5）', () => {
  it('manual は prompt をそのまま出して止まる', () => {
    const state = runToEnd(
      started(makeTable(), [{ op: 'manual', prompt: '相手の山札を確認してください' }]),
    );
    expect(state.execution?.pendingChoice).toMatchObject({
      kind: 'confirm',
      prompt: '相手の山札を確認してください',
    });
  });

  it('まだ自動化していないオペコードは、落ちずに止まる', () => {
    // ★useAttackAs は T43 で実装した。残っているものでここを守る
    const state = runToEnd(
      started(makeTable(), [
        {
          op: 'setCondition',
          target: { kind: 'active', player: 'opponent' },
          condition: 'poisoned',
        },
      ]),
    );
    expect(state.execution?.pendingChoice?.prompt).toContain('setCondition');
    expect(state.execution?.pendingChoice?.prompt).toContain('まだ自動化されていません');
  });

  it('cancelEffect で打ち切れる（卓が固まらない）', () => {
    const stuck = runToEnd(started(makeTable(), [{ op: 'manual', prompt: '手で処理' }]));
    const freed = applyAction(stuck, act({ type: 'cancelEffect', reason: '手で処理した' }), ctx);
    expect(freed.execution).toBeNull();
  });
});

// ── ログと再現性 ──

describe('効果もログに残り、同じログから同じ盤面になる（§4.2）', () => {
  it('1歩ごとに1行ログが増える', () => {
    const state = runToEnd(
      started(makeTable(), [
        { op: 'draw', player: 'self', count: 1 },
        { op: 'draw', player: 'self', count: 1 },
      ]),
    );
    const summaries = state.log.map((e) => e.summary);
    expect(summaries.filter((s) => s.startsWith('効果の処理'))).toHaveLength(2);
    expect(summaries).toContain('テストのカードの効果がはたらいた');
  });

  it('ログの Action を並べ直すと同じ盤面になる', () => {
    const order = [...Array(10).keys()].map((i) => `a-deck-${9 - i}`);
    const ops: Op[] = [
      { op: 'shuffle', zone: 'deck', owner: 'self' },
      { op: 'draw', player: 'self', count: 3 },
    ];
    const live = runToEnd(started(makeTable(), ops), { order });

    const replayed = applyActions(makeTable(), live.log.map((e) => e.action), ctx);
    expect(zoneOf(replayed, ALICE, 'hand')).toEqual(zoneOf(live, ALICE, 'hand'));
    expect(zoneOf(replayed, ALICE, 'deck')).toEqual(zoneOf(live, ALICE, 'deck'));
  });
});

// ── 参照の解決 ──

describe('createExecution', () => {
  it('作った時点で repeat が展開されている', () => {
    const execution = createExecution({
      executionId: 'x',
      ops: [{ op: 'repeat', times: 2, body: [{ op: 'draw', player: 'self', count: 1 }] }],
      source: SOURCE,
    });
    expect(execution.ops).toHaveLength(2);
    expect(execution.cursor).toBe(0);
    expect(execution.pendingChoice).toBeNull();
  });
});
