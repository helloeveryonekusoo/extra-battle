/**
 * T11 の完了条件: 「誤操作を巻き戻せる」
 *
 * 要求 → 相手が承認 → 盤面が戻る、までを Room に対して確かめる。
 */
import { describe, expect, it } from 'vitest';
import { cardsInZone, findSlot } from '@pokeca/shared';
import { Room } from './room';
import { loadCardTexts } from './cardStore';

const cardPool = loadCardTexts();

function makeTable() {
  let t = 1_800_000_000_000;
  const room = new Room({
    code: 'UNDO01',
    rngSeed: 'seed-undo',
    cardPool,
    now: () => (t += 1000),
  });
  const alice = room.join('アリス').playerId;
  const bob = room.join('ボブ').playerId;
  room.submitAction(alice, { type: 'setSetupStep', step: 'done' });
  room.submitIntent(alice, { type: 'devDealSampleDeck', playerId: alice, size: 30 });
  room.submitIntent(alice, { type: 'drawCards', playerId: alice, count: 5 });
  return { room, alice, bob };
}

describe('取り消しの要求と承認', () => {
  it('要求すると pendingUndo が立ち、両者に見える', () => {
    const { room, alice, bob } = makeTable();
    const seq = room.rawState.log[room.rawState.log.length - 1]!.seq;
    room.submitAction(alice, { type: 'requestUndo', targetSeq: seq });

    expect(room.rawState.pendingUndo?.requestedBy).toBe(alice);
    expect(room.rawState.pendingUndo?.targetSeq).toBe(seq);
    expect(room.stateFor(bob).pendingUndo?.status).toBe('pending');
  });

  it('自分の要求は自分では承認できない', () => {
    const { room, alice } = makeTable();
    const seq = room.rawState.log[room.rawState.log.length - 1]!.seq;
    room.submitAction(alice, { type: 'requestUndo', targetSeq: seq });
    const requestId = room.rawState.pendingUndo!.requestId;

    expect(() =>
      room.submitIntent(alice, { type: 'resolveUndo', requestId, approve: true }),
    ).toThrow(/自分では承認/);
  });

  it('断ると盤面は変わらず、要求だけ消える', () => {
    const { room, alice, bob } = makeTable();
    const before = cardsInZone(room.rawState, alice, 'hand').length;
    const seq = room.rawState.log[room.rawState.log.length - 1]!.seq;
    room.submitAction(alice, { type: 'requestUndo', targetSeq: seq });
    const requestId = room.rawState.pendingUndo!.requestId;

    room.submitIntent(bob, { type: 'resolveUndo', requestId, approve: false });

    expect(room.rawState.pendingUndo).toBeNull();
    expect(cardsInZone(room.rawState, alice, 'hand')).toHaveLength(before);
    expect(room.rawState.log[room.rawState.log.length - 1]?.summary).toContain('断った');
  });

  it('★承認すると盤面が巻き戻る', () => {
    const { room, alice, bob } = makeTable();
    const cardId = cardsInZone(room.rawState, alice, 'hand')[0]!.instanceId;

    // 誤操作: バトル場に出してダメカンを乗せてしまった
    const seqBeforeMistake = room.rawState.log[room.rawState.log.length - 1]!.seq + 1;
    room.submitAction(alice, {
      type: 'placePokemon',
      playerId: alice,
      slotId: 'active',
      cardId,
    });
    room.submitAction(alice, { type: 'adjustDamage', playerId: alice, slotId: 'active', delta: 6 });
    expect(findSlot(room.rawState, alice, 'active')?.damageCounters).toBe(6);
    const handBefore = cardsInZone(room.rawState, alice, 'hand').length;

    // 取り消しを要求してボブが承認する
    room.submitAction(alice, { type: 'requestUndo', targetSeq: seqBeforeMistake });
    const requestId = room.rawState.pendingUndo!.requestId;
    room.submitIntent(bob, { type: 'resolveUndo', requestId, approve: true });

    // 盤面が誤操作の前に戻っている
    expect(findSlot(room.rawState, alice, 'active')).toBeUndefined();
    expect(cardsInZone(room.rawState, alice, 'hand')).toHaveLength(handBefore + 1);
    expect(room.rawState.cards[cardId]?.zone).toBe('hand');
    expect(room.rawState.pendingUndo).toBeNull();
  });

  it('巻き戻してもログは消えず、取り消した操作に印がつく', () => {
    const { room, alice, bob } = makeTable();
    const cardId = cardsInZone(room.rawState, alice, 'hand')[0]!.instanceId;
    const seq = room.rawState.log[room.rawState.log.length - 1]!.seq + 1;

    room.submitAction(alice, { type: 'placePokemon', playerId: alice, slotId: 'active', cardId });
    const logLengthBefore = room.rawState.log.length;

    room.submitAction(alice, { type: 'requestUndo', targetSeq: seq });
    room.submitIntent(bob, {
      type: 'resolveUndo',
      requestId: room.rawState.pendingUndo!.requestId,
      approve: true,
    });

    const log = room.rawState.log;
    // 取り消した操作＋要求＋承認 のぶんログは増えている
    expect(log.length).toBeGreaterThan(logLengthBefore);
    expect(log.find((e) => e.seq === seq)?.undone).toBe(true);
    expect(log.find((e) => e.seq === seq - 1)?.undone).toBe(false);
    expect(log[log.length - 1]?.summary).toContain('承認');
  });

  it('★取り消されていないログだけを再生すると、同じ盤面になる（§4.2）', () => {
    const { room, alice, bob } = makeTable();
    const cardId = cardsInZone(room.rawState, alice, 'hand')[0]!.instanceId;
    const seq = room.rawState.log[room.rawState.log.length - 1]!.seq + 1;

    room.submitAction(alice, { type: 'placePokemon', playerId: alice, slotId: 'active', cardId });
    room.submitAction(alice, { type: 'adjustDamage', playerId: alice, slotId: 'active', delta: 3 });
    room.submitAction(alice, { type: 'requestUndo', targetSeq: seq });
    room.submitIntent(bob, {
      type: 'resolveUndo',
      requestId: room.rawState.pendingUndo!.requestId,
      approve: true,
    });

    // 巻き戻し後にもう一度操作する
    room.submitAction(alice, { type: 'setPhase', phase: 'pokemonCheck' });

    const live = room.rawState;
    const replayed = room.replayFromLog();

    expect(replayed.phase).toBe(live.phase);
    expect(replayed.players).toEqual(live.players);
    expect(replayed.cards).toEqual(live.cards);
  });

  it('古すぎる操作は巻き戻せない', () => {
    const { room, alice, bob } = makeTable();
    room.submitAction(alice, { type: 'requestUndo', targetSeq: 99999 });
    expect(() =>
      room.submitIntent(bob, {
        type: 'resolveUndo',
        requestId: room.rawState.pendingUndo!.requestId,
        approve: true,
      }),
    ).toThrow(/巻き戻せません/);
  });
});
