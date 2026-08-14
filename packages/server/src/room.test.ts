import { beforeEach, describe, expect, it } from 'vitest';
import { cardsInZone, findSlot, HIDDEN_FUNCTIONAL_ID, type CardText } from '@pokeca/shared';
import { Room, RoomError } from './room';
import { loadCardTexts } from './cardStore';

const cardPool = loadCardTexts();

const makeRoom = () => {
  let t = 1_800_000_000_000;
  return new Room({
    code: 'TEST01',
    rngSeed: 'seed-room',
    cardPool,
    now: () => (t += 1000),
  });
};

describe('Room の席', () => {
  it('2人まで座れて、3人目は断られる', () => {
    const room = makeRoom();
    expect(room.join('アリス').playerId).toBe('p-1');
    expect(room.join('ボブ').playerId).toBe('p-2');
    expect(() => room.join('チャーリー')).toThrow(RoomError);
  });

  it('playerId を添えれば、切断した自分の席に戻れる', () => {
    const room = makeRoom();
    const alice = room.join('アリス');
    room.join('ボブ');
    room.disconnect(alice.playerId);
    expect(room.presence.find((p) => p.playerId === alice.playerId)?.connected).toBe(false);

    const back = room.join('アリス', alice.playerId);
    expect(back.playerId).toBe(alice.playerId);
    expect(room.seatCount).toBe(2);
    expect(room.presence.find((p) => p.playerId === alice.playerId)?.connected).toBe(true);
  });

  it('席にいない人の操作は受け付けない', () => {
    const room = makeRoom();
    expect(() =>
      room.submitAction('p-9', { type: 'setPhase', phase: 'turn' }),
    ).toThrow(RoomError);
  });

  it('actorId はサーバーが上書きするので、他人になりすませない', () => {
    const room = makeRoom();
    const alice = room.join('アリス');
    room.join('ボブ');
    room.submitAction(alice.playerId, { type: 'note', text: 'テスト' });
    expect(room.rawState.log[room.rawState.log.length - 1]?.actorId).toBe(alice.playerId);
  });

  it('相手の切断中は盤面を進めない', () => {
    const room = makeRoom();
    const alice = room.join('アリス');
    const bob = room.join('ボブ');
    room.disconnect(bob.playerId);

    expect(() =>
      room.submitAction(alice.playerId, { type: 'note', text: '切断中の操作' }),
    ).toThrow('相手が切断中');
    expect(room.rawState.log.some((entry) => entry.summary.includes('切断中の操作'))).toBe(false);
  });

  it('入室時に選んだ保存デッキをサーバーで採番・シャッフルして置く', () => {
    const room = makeRoom();
    const first = cardPool[0]!;
    const second = cardPool[1]!;
    const alice = room.join('アリス', undefined, {
      name: '保存デッキ',
      cards: [
        { functionalId: first.functionalId, count: 4 },
        { functionalId: second.functionalId, count: 56 },
      ],
    });

    const deck = cardsInZone(room.rawState, alice.playerId, 'deck');
    expect(deck).toHaveLength(60);
    expect(deck.filter((card) => card.functionalId === first.functionalId)).toHaveLength(4);
    expect(new Set(deck.map((card) => card.instanceId)).size).toBe(60);
    expect(room.rawState.log.at(-1)?.action.type).toBe('setupDeck');
    expect(room.rawState.log.at(-1)?.seed).toMatch(/^seed-room:/);
  });

  it('保存デッキにカードプール外のIDがあれば理由を示す', () => {
    const room = makeRoom();
    expect(() =>
      room.join('アリス', undefined, {
        name: '壊れたデッキ',
        cards: [{ functionalId: 'unknown-card', count: 1 }],
      }),
    ).toThrow('不明なカード');
  });
});

describe('Room の乱数（§4.2）', () => {
  let room: Room;
  let alice: string;
  let bob: string;

  beforeEach(() => {
    room = makeRoom();
    alice = room.join('アリス').playerId;
    bob = room.join('ボブ').playerId;
  });

  it('デッキ投入は setupDeck になり、山札が積まれる', () => {
    room.submitIntent(alice, { type: 'devDealSampleDeck', playerId: alice, size: 20 });
    expect(cardsInZone(room.rawState, alice, 'deck')).toHaveLength(20);
  });

  it('ドローはサーバーが山札の上から取る', () => {
    room.submitIntent(alice, { type: 'devDealSampleDeck', playerId: alice, size: 20 });
    const top = cardsInZone(room.rawState, alice, 'deck')
      .slice(0, 7)
      .map((c) => c.instanceId);

    room.submitIntent(alice, { type: 'drawCards', playerId: alice, count: 7 });
    expect(cardsInZone(room.rawState, alice, 'hand').map((c) => c.instanceId)).toEqual(top);
    expect(cardsInZone(room.rawState, alice, 'deck')).toHaveLength(13);
  });

  it('シャッフルの並びが変わり、シードがログに残る', () => {
    room.submitIntent(alice, { type: 'devDealSampleDeck', playerId: alice, size: 20 });
    const before = cardsInZone(room.rawState, alice, 'deck').map((c) => c.instanceId);

    room.submitIntent(alice, { type: 'shuffleDeck', playerId: alice });
    const after = cardsInZone(room.rawState, alice, 'deck').map((c) => c.instanceId);

    expect(after).not.toEqual(before);
    expect([...after].sort()).toEqual([...before].sort());
    expect(room.rawState.log[room.rawState.log.length - 1]?.seed).toMatch(/^seed-room:\d+$/);
  });

  it('コインとじゃんけんの結果はサーバーが決める', () => {
    room.submitIntent(alice, { type: 'flipCoin', playerId: alice, count: 3, reason: 'ワザの効果' });
    const coin = room.rawState.log[room.rawState.log.length - 1];
    expect(coin?.actorId).toBe('server');
    expect(coin?.summary).toContain('コイン');

    room.submitIntent(alice, { type: 'randomChoice', label: 'じゃんけん', options: [alice, bob] });
    const janken = room.rawState.log[room.rawState.log.length - 1];
    expect([alice, bob]).toContain(
      janken?.action.type === 'randomChoice' ? janken.action.result : null,
    );
  });

  it('山札が空ならドローは断られる', () => {
    expect(() => room.submitIntent(alice, { type: 'drawCards', playerId: alice, count: 1 })).toThrow(
      /山札/,
    );
  });
});

describe('カード効果モード（T30）', () => {
  const autoCard: CardText = {
    ...cardPool[0]!,
    functionalId: 'auto-draw-card',
    name: '自動ドロー',
    effects: [{ op: 'draw', player: 'self', count: 1 }],
  };
  const manualCard: CardText = {
    ...cardPool[1]!,
    functionalId: 'manual-card',
    name: '手動カード',
    effects: null,
  };

  const effectRoom = () =>
    new Room({ code: 'MODE30', rngSeed: 'mode-seed', cardPool: [autoCard, manualCard] });

  it('AUTOカードはIDだけを受け取り、サーバーの定義を最後まで自動実行する', () => {
    const room = effectRoom();
    const alice = room.join('アリス').playerId;
    room.submitIntent(alice, { type: 'devDealSampleDeck', playerId: alice, size: 4 });
    const source = cardsInZone(room.rawState, alice, 'deck').find(
      (card) => card.functionalId === autoCard.functionalId,
    )!;
    room.submitAction(alice, { type: 'moveCard', cardId: source.instanceId, toZone: 'hand' });
    const handBefore = cardsInZone(room.rawState, alice, 'hand').length;

    room.submitIntent(alice, { type: 'useCardEffect', instanceId: source.instanceId });

    expect(cardsInZone(room.rawState, alice, 'hand')).toHaveLength(handBefore + 1);
    expect(room.rawState.execution).toBeNull();
    expect(room.rawState.log.some((entry) => entry.action.type === 'startEffect')).toBe(true);
    expect(room.rawState.log.some((entry) => entry.action.type === 'effectStep')).toBe(true);
  });

  it('MANUALカードは効果実行経路に入れず、従来の手動操作に任せる', () => {
    const room = effectRoom();
    const alice = room.join('アリス').playerId;
    room.submitIntent(alice, { type: 'devDealSampleDeck', playerId: alice, size: 4 });
    const source = cardsInZone(room.rawState, alice, 'deck').find(
      (card) => card.functionalId === manualCard.functionalId,
    )!;
    room.submitAction(alice, { type: 'moveCard', cardId: source.instanceId, toZone: 'hand' });

    expect(() =>
      room.submitIntent(alice, { type: 'useCardEffect', instanceId: source.instanceId }),
    ).toThrow('MANUAL');
  });
});

describe('Room が配る状態は可視性フィルタ済み（§4.1）', () => {
  it('相手の手札の中身は stateFor に含まれない', () => {
    const room = makeRoom();
    const alice = room.join('アリス').playerId;
    const bob = room.join('ボブ').playerId;

    room.submitIntent(bob, { type: 'devDealSampleDeck', playerId: bob, size: 20 });
    room.submitIntent(bob, { type: 'drawCards', playerId: bob, count: 7 });

    const forAlice = room.stateFor(alice);
    const bobsHand = cardsInZone(forAlice, bob, 'hand');
    expect(bobsHand).toHaveLength(7);
    expect(bobsHand.every((c) => c.functionalId === HIDDEN_FUNCTIONAL_ID)).toBe(true);

    // ボブ本人には見える
    expect(
      cardsInZone(room.stateFor(bob), bob, 'hand').every(
        (c) => c.functionalId !== HIDDEN_FUNCTIONAL_ID,
      ),
    ).toBe(true);
  });

  it('デッキリストがログから漏れない', () => {
    const room = makeRoom();
    const alice = room.join('アリス').playerId;
    const bob = room.join('ボブ').playerId;
    room.submitIntent(bob, { type: 'devDealSampleDeck', playerId: bob, size: 20 });

    const json = JSON.stringify(room.stateFor(alice));
    expect(json).not.toContain('smpl-pikachu');
    expect(json).not.toContain('seed-room');
  });

  it('盤面の操作は両者に見える', () => {
    const room = makeRoom();
    const alice = room.join('アリス').playerId;
    const bob = room.join('ボブ').playerId;

    room.submitIntent(alice, { type: 'devDealSampleDeck', playerId: alice, size: 20 });
    room.submitIntent(alice, { type: 'drawCards', playerId: alice, count: 1 });
    const cardId = cardsInZone(room.rawState, alice, 'hand')[0]!.instanceId;

    room.submitAction(alice, {
      type: 'placePokemon',
      playerId: alice,
      slotId: 'active',
      cardId,
    });
    room.submitAction(alice, { type: 'adjustDamage', playerId: alice, slotId: 'active', delta: 3 });

    const forBob = room.stateFor(bob);
    expect(findSlot(forBob, alice, 'active')?.damageCounters).toBe(3);
    expect(forBob.cards[cardId]?.functionalId).not.toBe(HIDDEN_FUNCTIONAL_ID);
  });
});
