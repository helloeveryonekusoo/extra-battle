/**
 * T25 の完了条件:
 *   「山札から2枚まで選んで手札に加える」がエンドツーエンドで動く。
 *   選択中にリロードしても選択画面に戻る。
 *
 * ここでは純粋ロジック側を確かめる（サーバー越しの往復は server/choice.test.ts）。
 * ★いちばん大事なのは「一時公開を必ず戻すこと」。
 *   戻し忘れると、山札を1回見ただけで以後ずっと中身が見えたままになる。
 */
import { describe, expect, it } from 'vitest';
import { applyAction, type Action } from './actions';
import { buildCardIndex } from './cards';
import { cardsInZone, createGameState, withCards } from './gameState';
import { canStep } from './interpreter';
import { filterStateFor, HIDDEN_FUNCTIONAL_ID } from './visibility';
import type { EffectSource, Op } from './dsl';
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
const STAGE1: CardText = { ...BASIC, functionalId: 'fn-stage1', name: 'カメール', stage: 'stage1', evolvesFrom: 'ゼニガメ' };
const ENERGY: CardText = {
  functionalId: 'fn-water',
  name: '基本水エネルギー',
  supertype: 'energy',
  isBasicEnergy: true,
  energyProvides: ['water'],
};

const ctx: RuleContext = { cards: buildCardIndex([BASIC, STAGE1, ENERGY]) };
const SOURCE: EffectSource = { instanceId: null, playerId: ALICE, label: 'ネストボール' };

/** アリスの山札9枚: たね3・1進化3・エネ3 が交互に並ぶ */
function makeTable(): GameState {
  const base = createGameState({
    gameId: 'g-choice',
    rngSeed: 'seed',
    seats: [
      { playerId: ALICE, displayName: 'アリス' },
      { playerId: BOB, displayName: 'ボブ' },
    ],
  });
  const FIDS = ['fn-basic', 'fn-stage1', 'fn-water'];
  const cards: CardInstance[] = [];
  for (let i = 0; i < 9; i += 1) {
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
  return withCards({ ...base, phase: 'turn', turn: 3, setup: null }, cards);
}

/** 山札から「たねポケモンを2枚まで」選んで手札に加える */
const searchOps = (over: Partial<Extract<Op, { op: 'search' }>> = {}): Op[] => [
  {
    op: 'search',
    from: 'deck',
    owner: 'self',
    filter: { supertype: ['pokemon'], stage: ['basic'] },
    count: 2,
    upTo: true,
    dest: 'hand',
    chooser: 'self',
    reveal: false,
    thenShuffle: false,
    ...over,
  },
];

function start(state: GameState, ops: Op[]): GameState {
  const started = applyAction(
    state,
    act({ type: 'startEffect', executionId: 'x1', ops, source: SOURCE }),
    ctx,
  );
  // 応答待ちになるまで回す
  let current = started;
  for (let i = 0; i < 20 && canStep(current); i += 1) {
    current = applyAction(current, act({ type: 'effectStep', executionId: 'x1' }), ctx);
  }
  return current;
}

/** 応答したあと、次に止まるまで進める（サーバーの runEffect と同じ動き） */
const answer = (
  state: GameState,
  selected: string[],
  rolls?: { order: string[] },
): GameState => {
  const requestId = state.execution?.pendingChoice?.requestId ?? '';
  let next = applyAction(
    state,
    act({ type: 'resolveChoice', requestId, selected, ...(rolls ? { rolls } : {}) }),
    ctx,
  );
  for (let i = 0; i < 20 && canStep(next); i += 1) {
    next = applyAction(next, act({ type: 'effectStep', executionId: 'x1' }), ctx);
  }
  return next;
};

const ids = (state: GameState, owner: PlayerId, zone: 'deck' | 'hand') =>
  cardsInZone(state, owner, zone).map((c) => c.instanceId);

// ── 完了条件 ──

describe('★山札から2枚まで選んで手札に加える', () => {
  it('条件に合うカードだけが候補になる', () => {
    const waiting = start(makeTable(), searchOps());
    const choice = waiting.execution?.pendingChoice;

    expect(choice?.kind).toBe('selectCards');
    expect(choice?.chooser).toBe(ALICE);
    expect(choice?.prompt).toBe('山札から2枚まで選んでください');
    // たねポケモンは 0 / 3 / 6 の3枚
    expect(choice?.candidates).toEqual(['a-deck-0', 'a-deck-3', 'a-deck-6']);
    expect(choice?.min).toBe(0);
    expect(choice?.max).toBe(2);
  });

  it('選んだカードが手札に入り、実行が終わる', () => {
    const answered = answer(start(makeTable(), searchOps()), ['a-deck-0', 'a-deck-6']);

    expect(ids(answered, ALICE, 'hand')).toEqual(['a-deck-0', 'a-deck-6']);
    expect(ids(answered, ALICE, 'deck')).toHaveLength(7);
    expect(answered.execution).toBeNull();
  });

  it('「▲▲まで」なら0枚でも抜けられる（§3.3）', () => {
    const answered = answer(start(makeTable(), searchOps()), []);
    expect(ids(answered, ALICE, 'hand')).toEqual([]);
    expect(answered.execution).toBeNull();
  });

  it('「▲▲まで」でなければ min = 枚数（0枚では抜けられない）', () => {
    const waiting = start(makeTable(), searchOps({ upTo: false }));
    expect(waiting.execution?.pendingChoice?.min).toBe(2);
  });

  it('候補が指定枚数より少なければ、あるだけが上限になる', () => {
    const waiting = start(
      makeTable(),
      searchOps({ filter: { supertype: ['energy'] }, count: 99, upTo: false }),
    );
    expect(waiting.execution?.pendingChoice?.max).toBe(3);
    expect(waiting.execution?.pendingChoice?.min).toBe(3);
  });

  it('条件に合うカードが1枚もなければ、聞かずに次へ進む', () => {
    const done = start(makeTable(), searchOps({ filter: { trainerKind: ['supporter'] } }));
    expect(done.execution).toBeNull();
  });

  it('候補にないカードを選んでも通らない', () => {
    const answered = answer(start(makeTable(), searchOps()), ['a-deck-1', 'a-deck-2']);
    expect(ids(answered, ALICE, 'hand')).toEqual([]);
  });

  it('bind すると、選んだカードが次のオペコードから使える', () => {
    const answered = answer(
      start(makeTable(), [
        ...searchOps({ bind: 'found' }),
        { op: 'draw', player: 'self', count: { binding: 'found' } },
      ]),
      ['a-deck-0', 'a-deck-3'],
    );
    // 選んだ2枚 + それを枚数として引いた2枚
    expect(ids(answered, ALICE, 'hand')).toHaveLength(4);
  });

  it('thenShuffle はサーバーが決めた並びで山札を切り直す', () => {
    const waiting = start(makeTable(), searchOps({ thenShuffle: true }));
    const rest = ['a-deck-8', 'a-deck-1', 'a-deck-2', 'a-deck-4', 'a-deck-5', 'a-deck-6', 'a-deck-7'];
    const answered = answer(waiting, ['a-deck-0', 'a-deck-3'], { order: rest });
    expect(ids(answered, ALICE, 'deck')).toEqual(rest);
  });
});

// ── 一時公開 ──

describe('★一時公開は選択が終わったら必ず戻る（§3.3）', () => {
  it('選択中は選ぶ側にだけ中身が見える', () => {
    const waiting = start(makeTable(), searchOps());

    // 候補は選ぶ側に見えている
    for (const id of waiting.execution?.pendingChoice?.candidates ?? []) {
      expect(waiting.cards[id]?.visibleTo).toContain(ALICE);
    }
    const seenByAlice = filterStateFor(waiting, ALICE);
    expect(seenByAlice.cards['a-deck-0']?.functionalId).toBe('fn-basic');

    // ★相手には見えない（伏せ名のまま）
    const seenByBob = filterStateFor(waiting, BOB);
    expect(seenByBob.cards['a-deck-0']).toBeUndefined();
    expect(Object.values(seenByBob.cards).every((c) => c.ownerId !== ALICE || c.zone !== 'deck' || c.functionalId === HIDDEN_FUNCTIONAL_ID)).toBe(true);
    // 相手に候補は渡らない。何を待っているかだけ見える
    expect(seenByBob.execution?.pendingChoice?.candidates).toEqual([]);
    expect(seenByBob.execution?.pendingChoice?.prompt).toBe('山札から2枚まで選んでください');
  });

  it('★答えたあと、選ばなかったカードは見えなくなる', () => {
    const answered = answer(start(makeTable(), searchOps()), ['a-deck-0']);

    // 選ばなかった候補は山札に伏せて戻っている
    expect(answered.cards['a-deck-3']?.visibleTo).toEqual([]);
    expect(answered.cards['a-deck-6']?.visibleTo).toEqual([]);
    // 選んだカードは手札なので自分にだけ見える
    expect(answered.cards['a-deck-0']?.visibleTo).toEqual([ALICE]);

    // 選んだカードは手札にあり、自分には正体が見える
    const seen = filterStateFor(answered, ALICE);
    expect(seen.cards['a-deck-0']?.functionalId).toBe('fn-basic');
    // ★選ばなかったカードは伏せ名に戻り、正体も見えない
    expect(seen.cards['a-deck-3']).toBeUndefined();
    const backInDeck = Object.values(seen.cards).filter(
      (c) => c.ownerId === ALICE && c.zone === 'deck',
    );
    expect(backInDeck).toHaveLength(8);
    expect(backInDeck.every((c) => c.functionalId === HIDDEN_FUNCTIONAL_ID)).toBe(true);
    expect(backInDeck.every((c) => c.instanceId.startsWith('hidden-'))).toBe(true);
  });

  it('★0枚で抜けても公開は戻る', () => {
    const answered = answer(start(makeTable(), searchOps()), []);
    for (const id of ['a-deck-0', 'a-deck-3', 'a-deck-6']) {
      expect(answered.cards[id]?.visibleTo).toEqual([]);
    }
  });

  it('★打ち切っても公開は戻る', () => {
    const waiting = start(makeTable(), searchOps());
    const cancelled = applyAction(waiting, act({ type: 'cancelEffect' }), ctx);
    for (const id of ['a-deck-0', 'a-deck-3', 'a-deck-6']) {
      expect(cancelled.cards[id]?.visibleTo).toEqual([]);
    }
  });

  it('★もともと見えていたカードの公開は剥がさない', () => {
    // 山札の1枚が別の効果で両者に公開されている状態から始める
    const table = makeTable();
    const revealed: GameState = {
      ...table,
      cards: {
        ...table.cards,
        'a-deck-0': { ...table.cards['a-deck-0']!, visibleTo: [ALICE, BOB] },
      },
    };

    const waiting = start(revealed, searchOps());
    // 一時公開として記録されるのは「今回足したぶん」だけ
    expect(waiting.execution?.pendingChoice?.temporarilyRevealed).toEqual(['a-deck-3', 'a-deck-6']);

    const answered = answer(waiting, []);
    expect(answered.cards['a-deck-0']?.visibleTo).toEqual([ALICE, BOB]);
    expect(answered.cards['a-deck-3']?.visibleTo).toEqual([]);
  });

  it('「相手に見せて」加えるなら、相手にも見えたまま手札に入る', () => {
    const answered = answer(start(makeTable(), searchOps({ reveal: true })), ['a-deck-0']);
    expect(answered.cards['a-deck-0']?.visibleTo).toEqual([ALICE, BOB]);
  });
});

// ── 途中で止まっていること ──

describe('★選択中にリロードしても選択画面に戻る', () => {
  it('JSON にして戻しても、聞かれている内容がそのまま残る', () => {
    const waiting = start(makeTable(), searchOps());
    const restored: GameState = JSON.parse(JSON.stringify(waiting)) as GameState;

    expect(restored.execution?.pendingChoice).toEqual(waiting.execution?.pendingChoice);
    expect(canStep(restored)).toBe(false);

    // 復元した状態からそのまま答えられる
    const answered = answer(restored, ['a-deck-0']);
    expect(ids(answered, ALICE, 'hand')).toEqual(['a-deck-0']);
  });

  it('古い requestId への応答は無視する', () => {
    const waiting = start(makeTable(), searchOps());
    const stale = applyAction(
      waiting,
      act({ type: 'resolveChoice', requestId: 'もう終わった要求', selected: ['a-deck-0'] }),
      ctx,
    );
    expect(stale.execution?.pendingChoice).not.toBeNull();
    expect(ids(stale, ALICE, 'hand')).toEqual([]);
  });
});

// ── manual の確認 ──

describe('manual は確認だけで先へ進める', () => {
  it('確認するとカーソルが進む', () => {
    const waiting = start(makeTable(), [
      { op: 'manual', prompt: '相手の山札を確認してください' },
      { op: 'draw', player: 'self', count: 1 },
    ]);
    expect(waiting.execution?.pendingChoice?.kind).toBe('confirm');
    expect(waiting.execution?.cursor).toBe(0);

    // 確認すると先へ進み、残りのオペコード（draw）も動く
    const next = answer(waiting, []);
    expect(next.execution).toBeNull();
    expect(ids(next, ALICE, 'hand')).toHaveLength(1);
  });
});
