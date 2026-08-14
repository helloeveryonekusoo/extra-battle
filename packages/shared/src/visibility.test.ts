import { describe, expect, it } from 'vitest';
import { applyAction, applyActions, type Action } from './actions';
import { cardsInZone } from './gameState';
import { filterStateFor, HIDDEN_FUNCTIONAL_ID, MASKED_CARD_ID } from './visibility';
import { ALICE, BOB, makeTable, tick } from './testFixtures';
import type { GameState } from './types';

const act = <T extends Omit<Action, 'actorId' | 'at'>>(a: T, actorId = ALICE): Action =>
  ({ ...a, actorId, at: tick() }) as Action;

/**
 * ボブの手札に「絶対に漏れてはいけない」目印のカードを1枚置いた卓。
 * 目印は JSON 全文検索で探せるように、他と衝突しない文字列にしてある。
 */
const SECRET = 'SECRET-DO-NOT-LEAK-9631';

function tableWithSecretInBobsHand(): GameState {
  const base = makeTable({ deckSize: 6 });
  const withSecret: GameState = {
    ...base,
    cards: {
      ...base.cards,
      'b-deck-0': { ...base.cards['b-deck-0']!, functionalId: SECRET },
    },
  };
  return applyAction(
    withSecret,
    act({ type: 'drawCards', playerId: BOB, cardIds: ['b-deck-0'] }, BOB),
  );
}

describe('★相手の手札の中身が結果に含まれない（§9-3 で省略禁止）', () => {
  const state = tableWithSecretInBobsHand();

  it('アリスから見た状態に、ボブの手札のカード名が一切出てこない', () => {
    const forAlice = filterStateFor(state, ALICE);
    // 構造をたどるだけでなく、シリアライズ全文に対して探す
    expect(JSON.stringify(forAlice)).not.toContain(SECRET);
  });

  it('アリスから見ると、ボブの手札は「枚数だけ分かるカード」になる', () => {
    const forAlice = filterStateFor(state, ALICE);
    const bobsHand = cardsInZone(forAlice, BOB, 'hand');
    expect(bobsHand).toHaveLength(1);
    expect(bobsHand[0]?.functionalId).toBe(HIDDEN_FUNCTIONAL_ID);
  });

  it('ボブ本人には自分の手札が見える', () => {
    const forBob = filterStateFor(state, BOB);
    expect(cardsInZone(forBob, BOB, 'hand')[0]?.functionalId).toBe(SECRET);
  });

  it('ログ経由でも漏れない', () => {
    const forAlice = filterStateFor(state, ALICE);
    expect(JSON.stringify(forAlice.log)).not.toContain(SECRET);
    const draw = forAlice.log.find((e) => e.action.type === 'drawCards');
    expect(draw?.action).toMatchObject({ cardIds: [MASKED_CARD_ID] });
  });
});

describe('可視性はゾーンではなくカード単位（§4.3）', () => {
  it('ウラのままバトル場に出したポケモンは、相手からも自分からも中身が見えない', () => {
    const state = applyAction(
      makeTable(),
      act(
        {
          type: 'placePokemon',
          playerId: BOB,
          slotId: 'active',
          cardId: 'b-deck-0',
          faceUp: false,
        },
        BOB,
      ),
    );
    const forAlice = filterStateFor(state, ALICE);
    const forBob = filterStateFor(state, BOB);

    // バトル場という「公開ゾーン」にいてもカード単位で伏せられる
    expect(forAlice.cards['b-deck-0']?.zone).toBe('active');
    expect(forAlice.cards['b-deck-0']?.functionalId).toBe(HIDDEN_FUNCTIONAL_ID);
    expect(forBob.cards['b-deck-0']?.functionalId).toBe(HIDDEN_FUNCTIONAL_ID);

    // オモテにすれば両者に見える
    const revealed = applyActions(state, [
      act({ type: 'setFaceUp', cardId: 'b-deck-0', faceUp: true }, BOB),
      act({ type: 'setCardVisibility', cardIds: ['b-deck-0'], visibleTo: [ALICE, BOB] }, BOB),
    ]);
    expect(filterStateFor(revealed, ALICE).cards['b-deck-0']?.functionalId).not.toBe(
      HIDDEN_FUNCTIONAL_ID,
    );
  });

  it('マリガンで相手に公開した手札だけが見える', () => {
    const state = applyActions(makeTable(), [
      act({ type: 'drawCards', playerId: BOB, cardIds: ['b-deck-0', 'b-deck-1'] }, BOB),
      act({ type: 'setCardVisibility', cardIds: ['b-deck-0'], visibleTo: [ALICE, BOB] }, BOB),
    ]);
    const forAlice = filterStateFor(state, ALICE);
    expect(forAlice.cards['b-deck-0']?.functionalId).not.toBe(HIDDEN_FUNCTIONAL_ID);
    expect(forAlice.cards['b-deck-1']?.functionalId).toBe(HIDDEN_FUNCTIONAL_ID);
  });

  it('ロストゾーンは両者に常時公開される', () => {
    const state = applyAction(
      makeTable(),
      act({ type: 'moveCard', cardId: 'b-deck-0', toZone: 'lost' }, BOB),
    );
    expect(filterStateFor(state, ALICE).cards['b-deck-0']?.functionalId).not.toBe(
      HIDDEN_FUNCTIONAL_ID,
    );
  });

  it('サイドをオモテにした1枚だけが見え、残りは伏せられたまま', () => {
    const state = applyActions(makeTable(), [
      act({ type: 'moveCard', cardId: 'b-deck-0', toZone: 'prize' }, BOB),
      act({ type: 'moveCard', cardId: 'b-deck-1', toZone: 'prize' }, BOB),
      act(
        {
          type: 'setCardVisibility',
          cardIds: ['b-deck-0'],
          visibleTo: [ALICE, BOB],
        },
        BOB,
      ),
    ]);
    const forAlice = filterStateFor(state, ALICE);
    expect(forAlice.cards['b-deck-0']?.functionalId).not.toBe(HIDDEN_FUNCTIONAL_ID);
    expect(cardsInZone(forAlice, BOB, 'prize')).toHaveLength(2);
    expect(forAlice.cards['b-deck-1']).toBeUndefined(); // 伏せ名になっている
  });
});

describe('山札・サイドの同一性を追跡させない', () => {
  const state = makeTable({ deckSize: 3 });

  it('山札のカードは伏せ名になり、本来の instanceId では引けない', () => {
    const forAlice = filterStateFor(state, ALICE);
    expect(forAlice.cards['a-deck-0']).toBeUndefined();
    expect(cardsInZone(forAlice, ALICE, 'deck')).toHaveLength(3);
    expect(cardsInZone(forAlice, ALICE, 'deck').map((c) => c.instanceId)).toEqual([
      'hidden-p-alice-deck-0',
      'hidden-p-alice-deck-1',
      'hidden-p-alice-deck-2',
    ]);
  });

  it('自分の山札の枚数は正しく分かる', () => {
    expect(cardsInZone(filterStateFor(state, ALICE), BOB, 'deck')).toHaveLength(3);
  });

  it('一度公開されたカードが山札に戻ると、また追跡できなくなる', () => {
    const revealed = applyActions(state, [
      act({ type: 'moveCard', cardId: 'a-deck-0', toZone: 'discard' }),
    ]);
    expect(filterStateFor(revealed, BOB).cards['a-deck-0']?.functionalId).not.toBe(
      HIDDEN_FUNCTIONAL_ID,
    );

    const backInDeck = applyAction(
      revealed,
      act(
        {
          type: 'shuffleIntoDeck',
          playerId: ALICE,
          cardIds: ['a-deck-0'],
          order: ['a-deck-1', 'a-deck-0', 'a-deck-2'],
        },
        'server',
      ),
    );
    expect(filterStateFor(backInDeck, BOB).cards['a-deck-0']).toBeUndefined();
    expect(filterStateFor(backInDeck, ALICE).cards['a-deck-0']).toBeUndefined();
  });

  it('シャッフル後の並びは、自分の山札であっても渡さない', () => {
    const shuffled = applyAction(
      state,
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
    for (const viewer of [ALICE, BOB]) {
      const entry = filterStateFor(shuffled, viewer).log[0];
      expect(entry?.action).toMatchObject({
        type: 'shuffleDeck',
        order: [MASKED_CARD_ID, MASKED_CARD_ID, MASKED_CARD_ID],
      });
    }
  });
});

describe('乱数の種を渡さない', () => {
  const state = applyAction(
    makeTable(),
    act(
      { type: 'flipCoin', playerId: ALICE, results: ['heads'], seed: 'seed-test:9' },
      'server',
    ),
  );

  it('GameState.rngSeed が空になる', () => {
    expect(state.rngSeed).toBe('seed-test');
    expect(filterStateFor(state, ALICE).rngSeed).toBe('');
  });

  it('LogEntry.seed も Action.seed も落ちる', () => {
    const filtered = filterStateFor(state, ALICE);
    expect(filtered.log[0]?.seed).toBeUndefined();
    expect(filtered.log[0]?.action.seed).toBeUndefined();
    expect(JSON.stringify(filtered)).not.toContain('seed-test:9');
  });
});

describe('ログの可視性', () => {
  it('自分に見えないログエントリは含まれない', () => {
    const state = applyAction(
      makeTable(),
      act({ type: 'note', text: 'ボブだけのメモ', logVisibleTo: [BOB] }, BOB),
    );
    expect(filterStateFor(state, BOB).log).toHaveLength(1);
    expect(filterStateFor(state, ALICE).log).toHaveLength(0);
  });

  it('コインの結果は両者に見える', () => {
    const state = applyAction(
      makeTable(),
      act({ type: 'flipCoin', playerId: ALICE, results: ['tails'] }, 'server'),
    );
    expect(filterStateFor(state, BOB).log[0]?.summary).toContain('ウラ');
  });
});

describe('フィルタ自体の性質', () => {
  it('入力の状態を書き換えない', () => {
    const state = tableWithSecretInBobsHand();
    const snapshot = structuredClone(state);
    filterStateFor(state, ALICE);
    expect(state).toEqual(snapshot);
  });

  it('公開情報は両者で一致する', () => {
    const state = applyActions(makeTable(), [
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-deck-0' }),
      act({ type: 'adjustDamage', playerId: ALICE, slotId: 'active', delta: 3 }),
      act({ type: 'setBenchLimit', playerId: ALICE, benchLimit: 8 }),
    ]);
    const a = filterStateFor(state, ALICE);
    const b = filterStateFor(state, BOB);
    expect(a.players).toEqual(b.players);
    expect(a.turn).toBe(b.turn);
    expect(a.activePlayer).toBe(b.activePlayer);
    expect(a.cards['a-deck-0']).toEqual(b.cards['a-deck-0']);
  });

  it('場のポケモンのスタック・エネルギー参照は壊れない', () => {
    const state = applyActions(makeTable(), [
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-deck-0' }),
      act({
        type: 'attachCard',
        playerId: ALICE,
        slotId: 'active',
        cardId: 'a-deck-1',
        as: 'energy',
      }),
    ]);
    const forBob = filterStateFor(state, BOB);
    const slot = forBob.players[ALICE]?.pokemon[0];
    expect(slot?.stack.every((id) => forBob.cards[id] !== undefined)).toBe(true);
    expect(slot?.attachedEnergy.every((id) => forBob.cards[id] !== undefined)).toBe(true);
  });
});
