/**
 * T10 の完了条件:
 * 「2人で対戦準備を最後まで通せる」
 *
 * じゃんけん → 先攻後攻 → 7枚 → たね確認 → マリガン → サイド6 → 開始 を
 * 実際の Room に対して2人ぶん流し、盤面が対戦開始の形になることを確かめる。
 */
import { describe, expect, it } from 'vitest';
import { cardsInZone, HIDDEN_FUNCTIONAL_ID } from '@pokeca/shared';
import { Room } from './room';
import { loadCardTexts } from './cardStore';

const cardPool = loadCardTexts();

function makeRoom() {
  let t = 1_800_000_000_000;
  const room = new Room({
    code: 'SETUP1',
    rngSeed: 'seed-setup',
    cardPool,
    now: () => (t += 1000),
  });
  const alice = room.join('アリス').playerId;
  const bob = room.join('ボブ').playerId;
  return { room, alice, bob };
}

describe('対戦準備の進行', () => {
  it('新しい卓は「じゃんけん」から始まる', () => {
    const { room } = makeRoom();
    expect(room.rawState.phase).toBe('setup');
    expect(room.rawState.setup?.step).toBe('janken');
  });

  it('じゃんけんの結果と先攻がターン順に反映される', () => {
    const { room, alice, bob } = makeRoom();
    room.submitIntent(alice, { type: 'randomChoice', label: 'じゃんけん', options: [alice, bob] });
    room.submitAction(alice, { type: 'setJankenWinner', playerId: bob });
    room.submitAction(bob, { type: 'setFirstPlayer', playerId: bob });

    expect(room.rawState.setup?.jankenWinner).toBe(bob);
    expect(room.rawState.setup?.firstPlayer).toBe(bob);
    expect(room.rawState.turnQueue).toEqual([bob, alice]);
    expect(room.rawState.activePlayer).toBe(bob);
  });

  it('マリガンで手札が山札に戻り、7枚引き直され、回数が記録される', () => {
    const { room, alice } = makeRoom();
    room.submitIntent(alice, { type: 'devDealSampleDeck', playerId: alice, size: 60 });
    room.submitIntent(alice, { type: 'drawCards', playerId: alice, count: 7 });

    const before = cardsInZone(room.rawState, alice, 'hand').map((c) => c.instanceId);
    room.submitIntent(alice, { type: 'mulligan', playerId: alice });

    const after = cardsInZone(room.rawState, alice, 'hand').map((c) => c.instanceId);
    expect(after).toHaveLength(7);
    expect(after).not.toEqual(before);
    expect(cardsInZone(room.rawState, alice, 'deck')).toHaveLength(53);
    expect(room.rawState.setup?.progress[alice]?.mulligans).toBe(1);
  });

  it('相手のマリガン回数が、追加ドローの宣言に使える', () => {
    const { room, alice, bob } = makeRoom();
    room.submitIntent(alice, { type: 'devDealSampleDeck', playerId: alice, size: 60 });
    room.submitIntent(alice, { type: 'drawCards', playerId: alice, count: 7 });
    room.submitIntent(alice, { type: 'mulligan', playerId: alice });
    room.submitIntent(alice, { type: 'mulligan', playerId: alice });

    expect(room.rawState.setup?.progress[alice]?.mulligans).toBe(2);

    room.submitAction(bob, { type: 'declareBonusDraw', playerId: bob, count: 2 });
    expect(room.rawState.setup?.progress[bob]?.bonusDraw).toBe(2);
  });

  it('サイドは山札の上から置かれ、中身は誰にも見えない', () => {
    const { room, alice, bob } = makeRoom();
    room.submitIntent(alice, { type: 'devDealSampleDeck', playerId: alice, size: 60 });
    room.submitIntent(alice, { type: 'dealPrizes', playerId: alice, count: 6 });

    expect(cardsInZone(room.rawState, alice, 'prize')).toHaveLength(6);
    expect(cardsInZone(room.rawState, alice, 'deck')).toHaveLength(54);
    expect(room.rawState.players[alice]?.prizesRemaining).toBe(6);

    for (const viewer of [alice, bob]) {
      const prizes = cardsInZone(room.stateFor(viewer), alice, 'prize');
      expect(prizes).toHaveLength(6);
      expect(prizes.every((c) => c.functionalId === HIDDEN_FUNCTIONAL_ID)).toBe(true);
    }
  });

  it('山札が足りなければサイドを置けない', () => {
    const { room, alice } = makeRoom();
    room.submitIntent(alice, { type: 'devDealSampleDeck', playerId: alice, size: 3 });
    expect(() => room.submitIntent(alice, { type: 'dealPrizes', playerId: alice, count: 6 })).toThrow(
      /足りません/,
    );
  });

  it('段を進めると、両者の「準備完了」が外れる', () => {
    const { room, alice, bob } = makeRoom();
    room.submitAction(alice, { type: 'setSetupReady', playerId: alice, ready: true });
    room.submitAction(bob, { type: 'setSetupReady', playerId: bob, ready: true });
    expect(room.rawState.setup?.progress[alice]?.ready).toBe(true);

    room.submitAction(alice, { type: 'setSetupStep', step: 'draw' });
    expect(room.rawState.setup?.progress[alice]?.ready).toBe(false);
    expect(room.rawState.setup?.progress[bob]?.ready).toBe(false);
  });
});

describe('★2人で対戦準備を最後まで通せる', () => {
  it('じゃんけんから対戦開始まで', () => {
    const { room, alice, bob } = makeRoom();
    const both = [alice, bob];

    // ① じゃんけん
    room.submitIntent(alice, { type: 'randomChoice', label: 'じゃんけん', options: both });
    room.submitAction(alice, { type: 'setJankenWinner', playerId: alice });
    room.submitAction(alice, { type: 'setSetupStep', step: 'order' });

    // ② 先攻・後攻
    room.submitAction(alice, { type: 'setFirstPlayer', playerId: alice });
    room.submitAction(alice, { type: 'setSetupStep', step: 'draw' });

    // ③ 山札を置いて切って7枚
    for (const p of both) {
      room.submitIntent(p, { type: 'devDealSampleDeck', playerId: p, size: 60 });
      room.submitIntent(p, { type: 'shuffleDeck', playerId: p });
      room.submitIntent(p, { type: 'drawCards', playerId: p, count: 7 });
    }
    room.submitAction(alice, { type: 'setSetupStep', step: 'mulligan' });

    // ④ たね確認とマリガン（ボブが1回マリガン、アリスが1枚追加ドローを宣言して引く）
    const bobsHand = cardsInZone(room.rawState, bob, 'hand').map((c) => c.instanceId);
    room.submitAction(bob, { type: 'setCardVisibility', cardIds: bobsHand, visibleTo: both });
    room.submitIntent(bob, { type: 'mulligan', playerId: bob });
    room.submitAction(alice, { type: 'declareBonusDraw', playerId: alice, count: 1 });
    room.submitIntent(alice, { type: 'drawCards', playerId: alice, count: 1 });
    expect(cardsInZone(room.rawState, alice, 'hand')).toHaveLength(8);
    room.submitAction(alice, { type: 'setSetupStep', step: 'place' });

    // ⑤ ウラのままバトル場とベンチに出す
    for (const p of both) {
      const hand = cardsInZone(room.rawState, p, 'hand').map((c) => c.instanceId);
      room.submitAction(p, {
        type: 'placePokemon',
        playerId: p,
        slotId: 'active',
        cardId: hand[0]!,
        faceUp: false,
      });
      room.submitAction(p, {
        type: 'placePokemon',
        playerId: p,
        slotId: 'bench-0',
        cardId: hand[1]!,
        faceUp: false,
      });
    }
    // ウラなので相手からは中身が見えない
    const aliceActiveId = room.rawState.players[alice]!.pokemon[0]!.stack[0]!;
    expect(room.stateFor(bob).cards[aliceActiveId]?.functionalId).toBe(HIDDEN_FUNCTIONAL_ID);
    room.submitAction(alice, { type: 'setSetupStep', step: 'prizes' });

    // ⑥ サイド6枚
    for (const p of both) {
      room.submitIntent(p, { type: 'dealPrizes', playerId: p, count: 6 });
    }
    room.submitAction(alice, { type: 'setSetupStep', step: 'reveal' });

    // ⑦ いっせいにオモテ
    for (const p of both) {
      const inPlay = room.rawState.players[p]!.pokemon.flatMap((s) => s.stack);
      for (const cardId of inPlay) {
        room.submitAction(p, { type: 'setFaceUp', cardId, faceUp: true });
      }
      room.submitAction(p, { type: 'setCardVisibility', cardIds: inPlay, visibleTo: both });
    }
    for (const p of both) {
      room.submitAction(p, { type: 'setSetupReady', playerId: p, ready: true });
    }
    room.submitAction(alice, { type: 'setSetupStep', step: 'done' });

    // ── 対戦開始の形になっているか ──
    const state = room.rawState;
    expect(state.setup).toBeNull();
    expect(state.phase).toBe('turn');
    expect(state.turn).toBe(1);
    expect(state.activePlayer).toBe(alice);

    for (const p of both) {
      expect(state.players[p]?.pokemon.length).toBe(2);
      expect(cardsInZone(state, p, 'prize')).toHaveLength(6);
      expect(state.players[p]?.prizesRemaining).toBe(6);
    }
    // 場のポケモンは両者に見えている
    expect(room.stateFor(bob).cards[aliceActiveId]?.functionalId).not.toBe(HIDDEN_FUNCTIONAL_ID);
    // 相手の手札は最後まで見えない
    const bobHand = cardsInZone(room.stateFor(alice), bob, 'hand');
    expect(bobHand.every((c) => c.functionalId === HIDDEN_FUNCTIONAL_ID)).toBe(true);
  });
});
