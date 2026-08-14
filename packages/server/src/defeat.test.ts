import { describe, expect, it } from 'vitest';
import { cardsInZone } from '@pokeca/shared';
import { loadCardTexts } from './cardStore';
import { Room } from './room';

const cardPool = loadCardTexts();

function table() {
  let now = 1_800_000_000_000;
  const room = new Room({
    code: 'LOSE01',
    rngSeed: 'seed-defeat',
    cardPool,
    now: () => (now += 1000),
  });
  const alice = room.join('アリス').playerId;
  const bob = room.join('ボブ').playerId;
  for (const playerId of [alice, bob]) {
    room.submitIntent(playerId, { type: 'devDealSampleDeck', playerId, size: 20 });
    const card = cardsInZone(room.rawState, playerId, 'deck')[0]!;
    room.submitAction(playerId, {
      type: 'placePokemon',
      playerId,
      slotId: 'active',
      cardId: card.instanceId,
    });
  }
  room.submitAction(alice, { type: 'setFirstPlayer', playerId: alice });
  room.submitAction(alice, { type: 'setSetupStep', step: 'done' });
  return { room, alice, bob };
}

describe('Room のT18勝敗処理', () => {
  it('番開始時に山札から引けないとデッキアウトを通知する', () => {
    const { room, alice, bob } = table();
    for (const card of cardsInZone(room.rawState, bob, 'deck')) {
      room.submitAction(bob, { type: 'moveCard', cardId: card.instanceId, toZone: 'discard' });
    }

    room.submitIntent(alice, { type: 'endTurn' });
    expect(room.rawState.gameEnd?.winnerId).toBe(alice);
    expect(room.rawState.gameEnd?.defeats[bob]).toContain('deckOut');
    expect(room.rawState.phase).toBe('turn');
  });

  it('公開盤面の敗北条件はdetectDefeat intentでサーバーが確定する', () => {
    const { room, alice, bob } = table();
    room.submitAction(alice, {
      type: 'setPrizes',
      playerId: alice,
      prizesRemaining: 0,
    });
    room.submitIntent(bob, { type: 'detectDefeat' });
    expect(room.rawState.gameEnd?.winnerId).toBe(alice);
    expect(room.rawState.gameEnd?.defeats[bob]).toEqual(['opponentPrizes']);
  });

  it('片方の確認では続行し、両者確認後だけ終了する', () => {
    const { room, alice, bob } = table();
    room.submitAction(alice, {
      type: 'setPrizes',
      playerId: alice,
      prizesRemaining: 0,
    });
    room.submitIntent(alice, { type: 'detectDefeat' });
    const proposalId = room.rawState.gameEnd!.proposalId;

    room.submitIntent(alice, { type: 'confirmGameEnd', proposalId });
    expect(room.rawState.phase).toBe('turn');
    room.submitIntent(bob, { type: 'confirmGameEnd', proposalId });
    expect(room.rawState.phase).toBe('ended');
  });
});
