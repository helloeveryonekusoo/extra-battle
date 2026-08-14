import { describe, expect, it } from 'vitest';
import { ActionError, applyAction, applyActions, type Action } from './actions';
import { cardsInZone, findSlot } from './gameState';
import { ALICE, BOB, makeTable, tick } from './testFixtures';
import type { GameState } from './types';

/** ActionBase の定型部分を埋める小さなヘルパ */
const act = <T extends Omit<Action, 'actorId' | 'at'>>(a: T, actorId = ALICE): Action =>
  ({ ...a, actorId, at: tick() }) as Action;

const ids = (state: GameState, owner: string, zone: Parameters<typeof cardsInZone>[2]) =>
  cardsInZone(state, owner, zone).map((c) => c.instanceId);

describe('applyAction の性質', () => {
  it('入力の状態を書き換えない（純粋関数）', () => {
    const before = makeTable();
    const snapshot = structuredClone(before);
    applyAction(before, act({ type: 'moveCard', cardId: 'a-deck-0', toZone: 'hand' }));
    expect(before).toEqual(snapshot);
  });

  it('操作ごとにログが1件積まれ、seq が連番になる', () => {
    const s = applyActions(makeTable(), [
      act({ type: 'moveCard', cardId: 'a-deck-0', toZone: 'hand' }),
      act({ type: 'moveCard', cardId: 'a-deck-1', toZone: 'discard' }),
    ]);
    expect(s.log.map((e) => e.seq)).toEqual([1, 2]);
    expect(s.log[1]?.summary).toContain('トラッシュ');
  });

  it('ログの要約に内部識別子が出ず、日本語のラベルになる', () => {
    const s = applyActions(makeTable(), [
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'bench-0', cardId: 'a-deck-0' }),
      act({
        type: 'setCondition',
        playerId: ALICE,
        slotId: 'bench-0',
        condition: 'poisoned',
        on: true,
      }),
      act({ type: 'setTurnFlag', playerId: ALICE, flag: 'supporterUsed', value: true }),
    ]);
    const summaries = s.log.map((e) => e.summary);
    expect(summaries[0]).toBe('アリスがベンチ1にポケモンを出した');
    expect(summaries[1]).toBe('アリスのベンチ1の「どく」を付与した');
    expect(summaries[2]).toBe('アリスの「サポート」を使用済みにした');
    // 内部の識別子がそのまま画面に出ていない
    expect(summaries.join('\n')).not.toMatch(/bench-0|poisoned|supporterUsed|p-alice/);
  });

  it('存在しないカードを触ると ActionError', () => {
    expect(() =>
      applyAction(makeTable(), act({ type: 'moveCard', cardId: 'nope', toZone: 'hand' })),
    ).toThrow(ActionError);
  });
});

describe('カードをゾーン間で移動できる', () => {
  it('山札から手札へ移すと、山札の position が詰め直される', () => {
    const s = applyAction(
      makeTable({ deckSize: 4 }),
      act({ type: 'moveCard', cardId: 'a-deck-1', toZone: 'hand' }),
    );
    expect(ids(s, ALICE, 'deck')).toEqual(['a-deck-0', 'a-deck-2', 'a-deck-3']);
    expect(cardsInZone(s, ALICE, 'deck').map((c) => c.position)).toEqual([0, 1, 2]);
    expect(ids(s, ALICE, 'hand')).toEqual(['a-deck-1']);
  });

  it('山札の上へ / 山札の下へ を撃ち分けられる', () => {
    const base = makeTable({ deckSize: 3 });
    const toTop = applyAction(
      base,
      act({ type: 'moveCard', cardId: 'a-deck-2', toZone: 'deck', insertAt: 'top' }),
    );
    expect(ids(toTop, ALICE, 'deck')).toEqual(['a-deck-2', 'a-deck-0', 'a-deck-1']);

    const toBottom = applyAction(
      base,
      act({ type: 'moveCard', cardId: 'a-deck-0', toZone: 'deck', insertAt: 'bottom' }),
    );
    expect(ids(toBottom, ALICE, 'deck')).toEqual(['a-deck-1', 'a-deck-2', 'a-deck-0']);
  });

  it('移動先ゾーンの既定の可視性が入るが、Action で上書きできる', () => {
    const base = makeTable();

    const toHand = applyAction(base, act({ type: 'moveCard', cardId: 'a-deck-0', toZone: 'hand' }));
    expect(toHand.cards['a-deck-0']?.visibleTo).toEqual([ALICE]);

    // ロストゾーンは両者常時公開（§4.3）
    const toLost = applyAction(base, act({ type: 'moveCard', cardId: 'a-deck-0', toZone: 'lost' }));
    expect(toLost.cards['a-deck-0']?.visibleTo).toEqual([ALICE, BOB]);

    // サイドをオモテにする効果 → 明示的に上書き
    const facedUpPrize = applyAction(
      base,
      act({
        type: 'moveCard',
        cardId: 'a-deck-0',
        toZone: 'prize',
        faceUp: true,
        visibleTo: [ALICE, BOB],
      }),
    );
    expect(facedUpPrize.cards['a-deck-0']?.faceUp).toBe(true);
    expect(facedUpPrize.cards['a-deck-0']?.visibleTo).toEqual([ALICE, BOB]);
  });

  it('ドローすると所有者だけに見える手札になる', () => {
    const s = applyAction(
      makeTable(),
      act({ type: 'drawCards', playerId: ALICE, cardIds: ['a-deck-0', 'a-deck-1'] }),
    );
    expect(ids(s, ALICE, 'hand')).toEqual(['a-deck-0', 'a-deck-1']);
    expect(s.cards['a-deck-0']?.visibleTo).toEqual([ALICE]);
  });

  it('シャッフルはサーバーが決めた並びをそのまま反映し、公開状態を伏せ直す', () => {
    const revealed = applyAction(
      makeTable({ deckSize: 3 }),
      act({ type: 'setCardVisibility', cardIds: ['a-deck-0'], visibleTo: [ALICE] }),
    );
    const s = applyAction(
      revealed,
      act(
        {
          type: 'shuffleDeck',
          playerId: ALICE,
          order: ['a-deck-2', 'a-deck-0', 'a-deck-1'],
          seed: 'seed-test:1',
        },
        'server',
      ),
    );
    expect(ids(s, ALICE, 'deck')).toEqual(['a-deck-2', 'a-deck-0', 'a-deck-1']);
    expect(s.cards['a-deck-0']?.visibleTo).toEqual([]);
    expect(s.log[1]?.seed).toBe('seed-test:1');
  });

  it('山札に加えて切る', () => {
    const withHand = applyAction(
      makeTable({ deckSize: 2 }),
      act({ type: 'moveCard', cardId: 'a-deck-0', toZone: 'hand' }),
    );
    const s = applyAction(
      withHand,
      act(
        {
          type: 'shuffleIntoDeck',
          playerId: ALICE,
          cardIds: ['a-deck-0'],
          order: ['a-deck-0', 'a-deck-1'],
        },
        'server',
      ),
    );
    expect(ids(s, ALICE, 'hand')).toEqual([]);
    expect(ids(s, ALICE, 'deck')).toEqual(['a-deck-0', 'a-deck-1']);
  });
});

describe('場のポケモン', () => {
  const placed = () =>
    applyAction(
      makeTable(),
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-deck-0' }),
    );

  it('バトル場に出すとスロットができ、カードのゾーンが active になる', () => {
    const s = placed();
    expect(findSlot(s, ALICE, 'active')?.stack).toEqual(['a-deck-0']);
    expect(s.cards['a-deck-0']?.zone).toBe('active');
    expect(findSlot(s, ALICE, 'active')?.placedOnTurn).toBe(1);
  });

  it('ウラのまま場に出せる（対戦準備）', () => {
    const s = applyAction(
      makeTable(),
      act({
        type: 'placePokemon',
        playerId: ALICE,
        slotId: 'active',
        cardId: 'a-deck-0',
        faceUp: false,
      }),
    );
    expect(s.cards['a-deck-0']?.zone).toBe('active');
    expect(s.cards['a-deck-0']?.faceUp).toBe(false);
    expect(s.cards['a-deck-0']?.visibleTo).toEqual([]);
  });

  it('埋まっているスロットに出そうとすると ActionError', () => {
    expect(() =>
      applyAction(
        placed(),
        act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-deck-1' }),
      ),
    ).toThrow(/埋まって/);
  });

  it('進化するとスタックが積まれ、退化させると一番上だけ剥がれる', () => {
    const evolved = applyAction(
      placed(),
      act({ type: 'evolvePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-deck-1' }),
    );
    expect(findSlot(evolved, ALICE, 'active')?.stack).toEqual(['a-deck-0', 'a-deck-1']);
    expect(findSlot(evolved, ALICE, 'active')?.evolvedOnTurn).toBe(1);

    const devolved = applyAction(
      evolved,
      act({ type: 'devolvePokemon', playerId: ALICE, slotId: 'active', toZone: 'hand' }),
    );
    expect(findSlot(devolved, ALICE, 'active')?.stack).toEqual(['a-deck-0']);
    expect(devolved.cards['a-deck-1']?.zone).toBe('hand');
  });

  it('エネルギーとどうぐをつけ外しできる', () => {
    const attached = applyActions(placed(), [
      act({
        type: 'attachCard',
        playerId: ALICE,
        slotId: 'active',
        cardId: 'a-deck-1',
        as: 'energy',
      }),
      act({
        type: 'attachCard',
        playerId: ALICE,
        slotId: 'active',
        cardId: 'a-deck-2',
        as: 'tool',
      }),
    ]);
    const slot = findSlot(attached, ALICE, 'active');
    expect(slot?.attachedEnergy).toEqual(['a-deck-1']);
    expect(slot?.attachedTool).toBe('a-deck-2');

    const detached = applyAction(
      attached,
      act({
        type: 'detachCard',
        playerId: ALICE,
        slotId: 'active',
        cardId: 'a-deck-1',
        toZone: 'discard',
      }),
    );
    expect(findSlot(detached, ALICE, 'active')?.attachedEnergy).toEqual([]);
    expect(detached.cards['a-deck-1']?.zone).toBe('discard');
  });

  it('カードが場を離れると、ついていた参照が自動で外れる', () => {
    const attached = applyAction(
      placed(),
      act({
        type: 'attachCard',
        playerId: ALICE,
        slotId: 'active',
        cardId: 'a-deck-1',
        as: 'tool',
      }),
    );
    // どうぐを moveCard で直接トラッシュへ送っても参照が残らない
    const s = applyAction(
      attached,
      act({ type: 'moveCard', cardId: 'a-deck-1', toZone: 'discard' }),
    );
    expect(findSlot(s, ALICE, 'active')?.attachedTool).toBeNull();
  });

  it('進化スタックが空になったスロットは消える', () => {
    const s = applyAction(placed(), act({ type: 'moveCard', cardId: 'a-deck-0', toZone: 'discard' }));
    expect(findSlot(s, ALICE, 'active')).toBeUndefined();
  });

  it('バトル場とベンチを入れ替えると、カードのゾーンも追従する', () => {
    const both = applyActions(placed(), [
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'bench-0', cardId: 'a-deck-1' }),
    ]);
    const s = applyAction(
      both,
      act({ type: 'movePokemon', playerId: ALICE, fromSlotId: 'bench-0', toSlotId: 'active' }),
    );
    expect(findSlot(s, ALICE, 'active')?.stack).toEqual(['a-deck-1']);
    expect(findSlot(s, ALICE, 'bench-0')?.stack).toEqual(['a-deck-0']);
    expect(s.cards['a-deck-1']?.zone).toBe('active');
    expect(s.cards['a-deck-0']?.zone).toBe('bench');
  });

  it('きぜつ処理として、ついていたカードごとまとめてトラッシュへ送れる', () => {
    const loaded = applyActions(placed(), [
      act({
        type: 'attachCard',
        playerId: ALICE,
        slotId: 'active',
        cardId: 'a-deck-1',
        as: 'energy',
      }),
      act({
        type: 'attachCard',
        playerId: ALICE,
        slotId: 'active',
        cardId: 'a-deck-2',
        as: 'tool',
      }),
    ]);
    const s = applyAction(
      loaded,
      act({ type: 'removePokemon', playerId: ALICE, slotId: 'active', toZone: 'discard' }),
    );
    expect(findSlot(s, ALICE, 'active')).toBeUndefined();
    expect(ids(s, ALICE, 'discard').sort()).toEqual(['a-deck-0', 'a-deck-1', 'a-deck-2']);
  });

  it('きぜつ確定は進化スタック・ついているカードを捨て、相手がサイドをとる', () => {
    const loaded = applyActions(placed(), [
      act({
        type: 'attachCard',
        playerId: ALICE,
        slotId: 'active',
        cardId: 'a-deck-1',
        as: 'energy',
      }),
      act({
        type: 'attachCard',
        playerId: ALICE,
        slotId: 'active',
        cardId: 'a-deck-2',
        as: 'tool',
      }),
      act({ type: 'moveCard', cardId: 'b-deck-0', toZone: 'prize' }),
      act({ type: 'moveCard', cardId: 'b-deck-1', toZone: 'prize' }),
    ]);
    const knockout = act({
      type: 'knockOut',
      playerId: ALICE,
      slotId: 'active',
      expectedTopInstanceId: 'a-deck-0',
      prizePlayerId: BOB,
      prizeCount: 2,
      prizeCardIds: ['b-deck-0', 'b-deck-1'],
    });
    const once = applyAction(loaded, knockout);

    expect(findSlot(once, ALICE, 'active')).toBeUndefined();
    expect(ids(once, ALICE, 'discard').sort()).toEqual(['a-deck-0', 'a-deck-1', 'a-deck-2']);
    expect(ids(once, BOB, 'hand').sort()).toEqual(['b-deck-0', 'b-deck-1']);
    expect(once.players[BOB]?.prizesRemaining).toBe(4);

    // 両画面から同じ確認が届いても、場とサイドの処理は一度だけ。
    const twice = applyAction(once, knockout);
    expect(ids(twice, BOB, 'hand').sort()).toEqual(['b-deck-0', 'b-deck-1']);
    expect(twice.players[BOB]?.prizesRemaining).toBe(4);
  });

  it('古い確認要求は、同じスロットにいる別のポケモンへ適用しない', () => {
    const loaded = applyActions(placed(), [
      act({ type: 'moveCard', cardId: 'b-deck-0', toZone: 'prize' }),
    ]);
    const s = applyAction(
      loaded,
      act({
        type: 'knockOut',
        playerId: ALICE,
        slotId: 'active',
        expectedTopInstanceId: '以前いたカード',
        prizePlayerId: BOB,
        prizeCount: 1,
        prizeCardIds: ['b-deck-0'],
      }),
    );
    expect(findSlot(s, ALICE, 'active')?.stack).toEqual(['a-deck-0']);
    expect(ids(s, BOB, 'hand')).toEqual([]);
    expect(s.players[BOB]?.prizesRemaining).toBe(6);
  });
});

describe('ダメカンを増減できる', () => {
  const placed = applyAction(
    makeTable(),
    act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-deck-0' }),
  );

  it('+10 / +50 / -10 を delta で表現できる', () => {
    const s = applyActions(placed, [
      act({ type: 'adjustDamage', playerId: ALICE, slotId: 'active', delta: 1 }),
      act({ type: 'adjustDamage', playerId: ALICE, slotId: 'active', delta: 5 }),
      act({ type: 'adjustDamage', playerId: ALICE, slotId: 'active', delta: -1 }),
    ]);
    expect(findSlot(s, ALICE, 'active')?.damageCounters).toBe(5);
  });

  it('0未満にはならない', () => {
    const s = applyAction(
      placed,
      act({ type: 'adjustDamage', playerId: ALICE, slotId: 'active', delta: -3 }),
    );
    expect(findSlot(s, ALICE, 'active')?.damageCounters).toBe(0);
  });

  it('HP超過は止めない（ルール判定をしないため）', () => {
    const s = applyAction(
      placed,
      act({ type: 'setDamage', playerId: ALICE, slotId: 'active', counters: 99 }),
    );
    expect(findSlot(s, ALICE, 'active')?.damageCounters).toBe(99);
  });
});

describe('特殊状態', () => {
  const placed = applyAction(
    makeTable(),
    act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-deck-0' }),
  );

  it('付与と解除ができ、重複しない', () => {
    const s = applyActions(placed, [
      act({ type: 'setCondition', playerId: ALICE, slotId: 'active', condition: 'poisoned', on: true }),
      act({ type: 'setCondition', playerId: ALICE, slotId: 'active', condition: 'poisoned', on: true }),
      act({ type: 'setCondition', playerId: ALICE, slotId: 'active', condition: 'asleep', on: true }),
    ]);
    expect(findSlot(s, ALICE, 'active')?.conditions).toEqual(['poisoned', 'asleep']);

    const cleared = applyAction(
      s,
      act({ type: 'setCondition', playerId: ALICE, slotId: 'active', condition: 'poisoned', on: false }),
    );
    expect(findSlot(cleared, ALICE, 'active')?.conditions).toEqual(['asleep']);
  });

  it('矛盾する組み合わせも止めない（判定は人間が行う）', () => {
    const s = applyActions(placed, [
      act({ type: 'setCondition', playerId: ALICE, slotId: 'active', condition: 'asleep', on: true }),
      act({ type: 'setCondition', playerId: ALICE, slotId: 'active', condition: 'paralyzed', on: true }),
    ]);
    expect(findSlot(s, ALICE, 'active')?.conditions).toHaveLength(2);
  });
});

describe('可変値とターン（§5.1）', () => {
  it('ベンチ上限とサイド枚数を後から変えられる', () => {
    const s = applyActions(makeTable(), [
      act({ type: 'setBenchLimit', playerId: ALICE, benchLimit: 8 }),
      act({ type: 'setPrizes', playerId: BOB, prizesRemaining: 4 }),
    ]);
    expect(s.players[ALICE]?.benchLimit).toBe(8);
    expect(s.players[BOB]?.prizesRemaining).toBe(4);
  });

  it('番を終えると turnQueue が進み、次のプレイヤーの制限が戻る', () => {
    const used = applyAction(
      makeTable(),
      act({ type: 'setTurnFlag', playerId: BOB, flag: 'supporterUsed', value: true }),
    );
    const s = applyAction(used, act({ type: 'endTurn' }));
    expect(s.activePlayer).toBe(BOB);
    expect(s.turn).toBe(2);
    expect(s.players[BOB]?.turnFlags.supporterUsed).toBe(false);
  });

  it('追加ターンを turnQueue に差し込める（ループにしていない）', () => {
    const s = applyActions(makeTable(), [
      act({ type: 'insertExtraTurn', playerId: ALICE }),
      act({ type: 'endTurn' }),
    ]);
    expect(s.activePlayer).toBe(ALICE);
    expect(s.turnQueue[0]).toBe(ALICE);
  });
});

describe('ワザの動的参照（§5.1-3）', () => {
  it('他カードのワザ参照を積んで、まとめて解除できる', () => {
    const placed = applyAction(
      makeTable(),
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-deck-0' }),
    );
    const granted = applyAction(
      placed,
      act({
        type: 'grantAttack',
        playerId: ALICE,
        slotId: 'active',
        ref: { functionalId: 'smpl-kamex', attackIndex: 1, sourceInstanceId: 'b-deck-0' },
      }),
    );
    expect(findSlot(granted, ALICE, 'active')?.grantedAttacks[0]?.sourceInstanceId).toBe('b-deck-0');

    const cleared = applyAction(
      granted,
      act({ type: 'clearGrantedAttacks', playerId: ALICE, slotId: 'active' }),
    );
    expect(findSlot(cleared, ALICE, 'active')?.grantedAttacks).toEqual([]);
  });
});

describe('乱数を伴う操作はログにだけ残る', () => {
  it('コインの結果はサーバーが決めたものをそのまま記録する', () => {
    const s = applyAction(
      makeTable(),
      act(
        {
          type: 'flipCoin',
          playerId: ALICE,
          results: ['heads', 'tails'],
          reason: 'ワザの効果',
          seed: 'seed-test:7',
        },
        'server',
      ),
    );
    expect(s.log[0]?.summary).toContain('オモテ ウラ');
    expect(s.log[0]?.seed).toBe('seed-test:7');
  });

  it('じゃんけんは randomChoice で表現し、結果は表示名で出る', () => {
    const s = applyAction(
      makeTable(),
      act({ type: 'randomChoice', label: 'じゃんけん', options: [ALICE, BOB], result: BOB }, 'server'),
    );
    expect(s.log[0]?.summary).toBe('じゃんけん: ボブ');
    expect(s.log[0]?.summary).not.toContain(BOB);
  });

  it('プレイヤー以外の選択肢はそのまま出る', () => {
    const s = applyAction(
      makeTable(),
      act({ type: 'randomChoice', label: '順番', options: ['表', '裏'], result: '表' }, 'server'),
    );
    expect(s.log[0]?.summary).toBe('順番: 表');
  });
});
