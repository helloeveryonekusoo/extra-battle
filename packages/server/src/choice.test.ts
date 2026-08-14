/**
 * T25 をサーバー越しに確かめる（エンドツーエンド）。
 *
 * ★「山札から2枚まで選んで手札に加える」の往復と、
 *   一時公開が本人にだけ届き、答えたあとに必ず戻ることを見る。
 */
import { describe, expect, it } from 'vitest';
import {
  cardsInZone,
  HIDDEN_FUNCTIONAL_ID,
  type EffectSource,
  type Op,
} from '@pokeca/shared';
import { Room, RoomError } from './room';
import { loadCardTexts } from './cardStore';

const cardPool = loadCardTexts();

function seatedRoom() {
  let t = 1_800_000_000_000;
  const room = new Room({
    code: 'CHOI01',
    rngSeed: 'seed-choice',
    cardPool,
    now: () => (t += 1000),
  });
  const alice = room.join('アリス').playerId;
  const bob = room.join('ボブ').playerId;
  for (const playerId of [alice, bob]) {
    room.submitIntent(playerId, { type: 'devDealSampleDeck', playerId, size: 60 });
    room.submitIntent(playerId, { type: 'drawCards', playerId, count: 5 });
  }
  return { room, alice, bob };
}

const sourceOf = (playerId: string): EffectSource => ({
  instanceId: null,
  playerId,
  label: 'ネストボール',
});

/** 山札からたねポケモンを2枚まで選んで手札に加え、切り直す */
const SEARCH: Op[] = [
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
    thenShuffle: true,
  },
];

const start = (room: Room, playerId: string, ops: Op[] = SEARCH) =>
  room.submitAction(playerId, {
    type: 'startEffect',
    executionId: 'e-search',
    ops,
    source: sourceOf(playerId),
  });

describe('★山札から2枚まで選んで手札に加える（往復）', () => {
  it('候補が届き、選んだ2枚が手札に入り、山札が切り直される', () => {
    const { room, alice } = seatedRoom();
    const handBefore = cardsInZone(room.rawState, alice, 'hand').length;
    const deckBefore = cardsInZone(room.rawState, alice, 'deck').map((c) => c.instanceId);

    start(room, alice);

    const choice = room.stateFor(alice).execution?.pendingChoice;
    expect(choice?.kind).toBe('selectCards');
    expect(choice?.prompt).toBe('山札から2枚まで選んでください');
    expect(choice?.min).toBe(0);
    expect(choice?.max).toBe(2);
    expect(choice?.candidates.length).toBeGreaterThan(0);

    const picked = choice!.candidates.slice(0, 2);
    room.submitIntent(alice, {
      type: 'resolveChoice',
      requestId: choice!.requestId,
      selected: picked,
    });

    expect(room.rawState.execution).toBeNull();
    const hand = cardsInZone(room.rawState, alice, 'hand').map((c) => c.instanceId);
    expect(hand).toHaveLength(handBefore + 2);
    for (const id of picked) expect(hand).toContain(id);

    // thenShuffle が効いて並びが変わっている
    const deckAfter = cardsInZone(room.rawState, alice, 'deck').map((c) => c.instanceId);
    expect(deckAfter).toHaveLength(deckBefore.length - 2);
    expect(deckAfter).not.toEqual(deckBefore.filter((id) => !picked.includes(id)));
  });

  it('★「▲▲まで」なので0枚でも抜けられる', () => {
    const { room, alice } = seatedRoom();
    const handBefore = cardsInZone(room.rawState, alice, 'hand').length;
    start(room, alice);

    const choice = room.stateFor(alice).execution!.pendingChoice!;
    room.submitIntent(alice, { type: 'resolveChoice', requestId: choice.requestId, selected: [] });

    expect(room.rawState.execution).toBeNull();
    expect(cardsInZone(room.rawState, alice, 'hand')).toHaveLength(handBefore);
  });
});

describe('★一時公開は本人にだけ届き、答えたら戻る', () => {
  it('選択中は本人にだけ候補の正体が見える', () => {
    const { room, alice, bob } = seatedRoom();
    start(room, alice);

    const choice = room.stateFor(alice).execution!.pendingChoice!;
    const seenByAlice = room.stateFor(alice);
    for (const id of choice.candidates) {
      expect(seenByAlice.cards[id]?.functionalId).not.toBe(HIDDEN_FUNCTIONAL_ID);
    }

    // 相手側: 候補は空、山札の中身も見えない
    const seenByBob = room.stateFor(bob);
    expect(seenByBob.execution?.pendingChoice?.candidates).toEqual([]);
    expect(seenByBob.execution?.pendingChoice?.prompt).toBe('山札から2枚まで選んでください');
    const aliceDeckAsBobSees = Object.values(seenByBob.cards).filter(
      (c) => c.ownerId === alice && c.zone === 'deck',
    );
    expect(aliceDeckAsBobSees.every((c) => c.functionalId === HIDDEN_FUNCTIONAL_ID)).toBe(true);
  });

  it('★答えたあと、選ばなかったカードは伏せ名に戻る', () => {
    const { room, alice } = seatedRoom();
    start(room, alice);

    const choice = room.stateFor(alice).execution!.pendingChoice!;
    const notPicked = choice.candidates.slice(2);
    room.submitIntent(alice, {
      type: 'resolveChoice',
      requestId: choice.requestId,
      selected: choice.candidates.slice(0, 2),
    });

    const seen = room.stateFor(alice);
    for (const id of notPicked) {
      // 本当の instanceId ではもう引けない（伏せ名に戻っている）
      expect(seen.cards[id]).toBeUndefined();
      expect(room.rawState.cards[id]?.visibleTo).toEqual([]);
    }
  });

  it('★打ち切っても一時公開は戻る（山札が見放題にならない）', () => {
    const { room, alice } = seatedRoom();
    start(room, alice);
    const choice = room.stateFor(alice).execution!.pendingChoice!;

    room.submitAction(alice, { type: 'cancelEffect', reason: '手で処理する' });

    expect(room.rawState.execution).toBeNull();
    for (const id of choice.candidates) {
      expect(room.rawState.cards[id]?.visibleTo).toEqual([]);
    }
    const seen = room.stateFor(alice);
    const deck = Object.values(seen.cards).filter((c) => c.ownerId === alice && c.zone === 'deck');
    expect(deck.every((c) => c.functionalId === HIDDEN_FUNCTIONAL_ID)).toBe(true);
  });
});

describe('答えられるのは頼まれた本人だけ', () => {
  it('相手が答えようとしても断る', () => {
    const { room, alice, bob } = seatedRoom();
    start(room, alice);
    const choice = room.stateFor(alice).execution!.pendingChoice!;

    expect(() =>
      room.submitIntent(bob, {
        type: 'resolveChoice',
        requestId: choice.requestId,
        selected: choice.candidates.slice(0, 1),
      }),
    ).toThrow(RoomError);
    expect(room.rawState.execution?.pendingChoice).not.toBeNull();
  });

  it('古い要求への応答は断る', () => {
    const { room, alice } = seatedRoom();
    start(room, alice);
    expect(() =>
      room.submitIntent(alice, { type: 'resolveChoice', requestId: 'むかしの要求', selected: [] }),
    ).toThrow(RoomError);
  });

  it('枚数が範囲外なら断る', () => {
    const { room, alice } = seatedRoom();
    // 「▲▲まで」ではない指定にすると 2枚必須になる
    start(room, alice, [{ ...(SEARCH[0] as Extract<Op, { op: 'search' }>), upTo: false }]);
    const choice = room.stateFor(alice).execution!.pendingChoice!;
    expect(choice.min).toBe(2);

    expect(() =>
      room.submitIntent(alice, { type: 'resolveChoice', requestId: choice.requestId, selected: [] }),
    ).toThrow(/選ぶ枚数/);
  });
});

describe('★選択中にリロードしても選択画面に戻る', () => {
  it('切断して同じ席に戻ると、聞かれている内容がそのまま届く', () => {
    const { room, alice } = seatedRoom();
    start(room, alice);
    const before = room.stateFor(alice).execution!.pendingChoice!;

    room.disconnect(alice);
    room.join('アリス', alice);

    const after = room.stateFor(alice).execution?.pendingChoice;
    expect(after).toEqual(before);

    // そのまま答えられる
    room.submitIntent(alice, {
      type: 'resolveChoice',
      requestId: after!.requestId,
      selected: after!.candidates.slice(0, 1),
    });
    expect(room.rawState.execution).toBeNull();
  });

  it('ログから再生しても同じ盤面になる', () => {
    const { room, alice } = seatedRoom();
    start(room, alice);
    const choice = room.stateFor(alice).execution!.pendingChoice!;
    room.submitIntent(alice, {
      type: 'resolveChoice',
      requestId: choice.requestId,
      selected: choice.candidates.slice(0, 2),
    });

    const replayed = room.replayFromLog();
    expect(replayed.cards).toEqual(room.rawState.cards);
    expect(replayed.execution).toEqual(room.rawState.execution);
  });
});
