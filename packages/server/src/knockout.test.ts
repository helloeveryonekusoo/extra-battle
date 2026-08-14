import { describe, expect, it } from 'vitest';
import { cardsInZone, findSlot } from '@pokeca/shared';
import { loadCardTexts } from './cardStore';
import { Room } from './room';

const cardPool = loadCardTexts();

function table() {
  let now = 1_800_000_000_000;
  const room = new Room({
    code: 'KO0001',
    rngSeed: 'seed-knockout',
    cardPool,
    now: () => (now += 1000),
  });
  const alice = room.join('アリス').playerId;
  const bob = room.join('ボブ').playerId;
  room.submitIntent(alice, { type: 'devDealSampleDeck', playerId: alice, size: 20 });
  room.submitIntent(bob, { type: 'devDealSampleDeck', playerId: bob, size: 20 });
  room.submitIntent(bob, { type: 'dealPrizes', playerId: bob, count: 6 });
  const target = cardsInZone(room.rawState, alice, 'deck')[0]!;
  room.submitAction(alice, {
    type: 'placePokemon',
    playerId: alice,
    slotId: 'active',
    cardId: target.instanceId,
  });
  return { room, alice, bob, target };
}

describe('Room のきぜつ確定', () => {
  it('伏せたサイドのIDはサーバーが選び、指定枚数だけ手札へ移す', () => {
    const { room, alice, bob, target } = table();
    const prizes = cardsInZone(room.rawState, bob, 'prize').map((card) => card.instanceId);

    room.submitIntent(bob, {
      type: 'knockOut',
      playerId: alice,
      slotId: 'active',
      expectedTopInstanceId: target.instanceId,
      prizePlayerId: bob,
      prizeCount: 2,
    });

    expect(findSlot(room.rawState, alice, 'active')).toBeUndefined();
    expect(cardsInZone(room.rawState, bob, 'hand').map((card) => card.instanceId)).toEqual(
      prizes.slice(0, 2),
    );
    expect(room.rawState.players[bob]?.prizesRemaining).toBe(4);
  });

  it('両者の同時確定と、入れ替わった後に届いた古い要求をno-opにする', () => {
    const { room, alice, bob, target } = table();
    const intent = {
      type: 'knockOut' as const,
      playerId: alice,
      slotId: 'active' as const,
      expectedTopInstanceId: target.instanceId,
      prizePlayerId: bob,
      prizeCount: 1,
    };

    room.submitIntent(alice, intent);
    const afterFirst = cardsInZone(room.rawState, bob, 'hand').length;
    room.submitIntent(bob, intent);
    expect(cardsInZone(room.rawState, bob, 'hand')).toHaveLength(afterFirst);
    expect(room.rawState.players[bob]?.prizesRemaining).toBe(5);

    const replacement = cardsInZone(room.rawState, alice, 'deck')[0]!;
    room.submitAction(alice, {
      type: 'placePokemon',
      playerId: alice,
      slotId: 'active',
      cardId: replacement.instanceId,
    });
    room.submitIntent(bob, intent);
    expect(findSlot(room.rawState, alice, 'active')?.stack).toEqual([replacement.instanceId]);
    expect(cardsInZone(room.rawState, bob, 'hand')).toHaveLength(afterFirst);
  });
});
