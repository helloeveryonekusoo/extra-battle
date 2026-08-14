/**
 * T13 の完了条件:
 * 「交互に番が進む。追加ターンを手動で挿入でき、履歴に isExtra: true で残る」
 */
import { describe, expect, it } from 'vitest';
import { cardsInZone } from '@pokeca/shared';
import { Room } from './room';
import { loadCardTexts } from './cardStore';

const cardPool = loadCardTexts();

function startedTable() {
  let t = 1_800_000_000_000;
  const room = new Room({
    code: 'TURN01',
    rngSeed: 'seed-turn',
    cardPool,
    now: () => (t += 1000),
  });
  const alice = room.join('アリス').playerId;
  const bob = room.join('ボブ').playerId;
  for (const p of [alice, bob]) {
    room.submitIntent(p, { type: 'devDealSampleDeck', playerId: p, size: 60 });
    room.submitIntent(p, { type: 'drawCards', playerId: p, count: 7 });
  }
  room.submitAction(alice, { type: 'setFirstPlayer', playerId: alice });
  room.submitAction(alice, { type: 'setSetupStep', step: 'done' });
  return { room, alice, bob };
}

describe('ターン構造', () => {
  it('対戦開始で第1番が履歴に載り、先攻が記録される', () => {
    const { room, alice } = startedTable();
    const s = room.rawState;
    expect(s.turn).toBe(1);
    expect(s.activePlayer).toBe(alice);
    expect(s.firstPlayer).toBe(alice);
    expect(s.turnHistory).toEqual([{ turn: 1, playerId: alice, isExtra: false }]);
  });

  it('★交互に番が進む', () => {
    const { room, alice, bob } = startedTable();
    for (let i = 0; i < 4; i += 1) {
      room.submitIntent(room.rawState.activePlayer, { type: 'endTurn' });
    }
    expect(room.rawState.turnHistory.map((t) => t.playerId)).toEqual([
      alice,
      bob,
      alice,
      bob,
      alice,
    ]);
    expect(room.rawState.turn).toBe(5);
  });

  it('番の開始時に次のプレイヤーが1枚引く', () => {
    const { room, alice, bob } = startedTable();
    const before = cardsInZone(room.rawState, bob, 'hand').length;
    room.submitIntent(alice, { type: 'endTurn' });

    expect(room.rawState.activePlayer).toBe(bob);
    expect(cardsInZone(room.rawState, bob, 'hand')).toHaveLength(before + 1);
    expect(room.rawState.log[room.rawState.log.length - 1]?.summary).toContain('1枚引いた');
  });

  it('ドローなしで番を終えることもできる', () => {
    const { room, alice, bob } = startedTable();
    const before = cardsInZone(room.rawState, bob, 'hand').length;
    room.submitIntent(alice, { type: 'endTurn', drawCount: 0 });
    expect(cardsInZone(room.rawState, bob, 'hand')).toHaveLength(before);
  });

  it('山札が空でも番は進む（ドローしないだけ。敗北判定は T18）', () => {
    const { room, alice, bob } = startedTable();
    for (const card of cardsInZone(room.rawState, bob, 'deck')) {
      room.submitAction(bob, { type: 'moveCard', cardId: card.instanceId, toZone: 'discard' });
    }
    expect(cardsInZone(room.rawState, bob, 'deck')).toHaveLength(0);

    room.submitIntent(alice, { type: 'endTurn' });
    expect(room.rawState.activePlayer).toBe(bob);
    expect(room.rawState.turn).toBe(2);
  });

  it('番の開始で1ターン制限がリセットされる', () => {
    const { room, alice, bob } = startedTable();
    room.submitAction(bob, { type: 'setTurnFlag', playerId: bob, flag: 'supporterUsed', value: true });
    room.submitIntent(alice, { type: 'endTurn' });
    expect(room.rawState.players[bob]?.turnFlags.supporterUsed).toBe(false);
  });
});

describe('★追加の番', () => {
  it('手動で差し込め、履歴に isExtra: true で残る', () => {
    const { room, alice, bob } = startedTable();

    // アリスの番の途中で、アリスの追加の番を差し込む
    room.submitAction(alice, {
      type: 'insertExtraTurn',
      playerId: alice,
      source: 'スタークロノス',
    });
    expect(room.rawState.turnQueue).toEqual([alice, alice, bob]);

    room.submitIntent(alice, { type: 'endTurn' });

    expect(room.rawState.activePlayer).toBe(alice);
    const latest = room.rawState.turnHistory[room.rawState.turnHistory.length - 1];
    expect(latest).toEqual({
      turn: 2,
      playerId: alice,
      isExtra: true,
      source: 'スタークロノス',
    });

    // 追加の番が終われば、通常どおりボブへ
    room.submitIntent(alice, { type: 'endTurn' });
    expect(room.rawState.activePlayer).toBe(bob);
    expect(room.rawState.turnHistory[room.rawState.turnHistory.length - 1]?.isExtra).toBe(false);
  });

  it('理由なしでも差し込める', () => {
    const { room, alice } = startedTable();
    room.submitAction(alice, { type: 'insertExtraTurn', playerId: alice });
    room.submitIntent(alice, { type: 'endTurn' });
    const latest = room.rawState.turnHistory[room.rawState.turnHistory.length - 1];
    expect(latest?.isExtra).toBe(true);
    expect(latest?.source).toBeUndefined();
  });

  it('turnQueue と turnQueueMeta の長さが常に一致する', () => {
    const { room, alice, bob } = startedTable();
    const check = () =>
      expect(room.rawState.turnQueueMeta).toHaveLength(room.rawState.turnQueue.length);

    check();
    room.submitAction(alice, { type: 'insertExtraTurn', playerId: alice, source: 'A' });
    check();
    room.submitAction(alice, { type: 'insertExtraTurn', playerId: bob, atIndex: 0 });
    check();
    room.submitIntent(room.rawState.activePlayer, { type: 'endTurn' });
    check();
  });

  it('巻き戻すと追加の番の挿入もなかったことになる', () => {
    const { room, alice, bob } = startedTable();
    const seq = room.rawState.log[room.rawState.log.length - 1]!.seq + 1;

    room.submitAction(alice, { type: 'insertExtraTurn', playerId: alice, source: 'まちがい' });
    expect(room.rawState.turnQueue).toHaveLength(3);

    room.submitAction(alice, { type: 'requestUndo', targetSeq: seq });
    room.submitIntent(bob, {
      type: 'resolveUndo',
      requestId: room.rawState.pendingUndo!.requestId,
      approve: true,
    });

    expect(room.rawState.turnQueue).toEqual([alice, bob]);
    expect(room.rawState.turnQueueMeta).toHaveLength(2);
  });
});
