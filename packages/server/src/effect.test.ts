/**
 * T24 をサーバー越しに確かめる。
 *
 * 見たいのは3つ:
 *   - サーバーが「応答待ちか終わりまで」自動で回すこと
 *   - シャッフルの乱数をサーバーが決め、その結果が Action に載ること（§4.2）
 *   - ★保存 → 復元 でも、ログからの再生でも、同じ盤面になること
 */
import { describe, expect, it } from 'vitest';
import { cardsInZone, type EffectSource, type LogEntry, type Op } from '@pokeca/shared';
import { Room } from './room';
import { loadCardTexts } from './cardStore';

const cardPool = loadCardTexts();

function makeRoom() {
  let t = 1_800_000_000_000;
  return new Room({
    code: 'EFCT01',
    rngSeed: 'seed-effect',
    cardPool,
    now: () => (t += 1000),
  });
}

/** 2人が座り、両者に山札60枚と手札5枚がある卓 */
function seatedRoom() {
  const room = makeRoom();
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
  label: '博士の研究',
});

const zone = (room: Room, owner: string, z: 'deck' | 'hand' | 'discard') =>
  cardsInZone(room.rawState, owner, z).map((c) => c.instanceId);

/** いちばん新しい effectStep のログ（lib が ES2022 なので findLast は使わない） */
const lastEffectStep = (log: readonly LogEntry[]): LogEntry | undefined =>
  [...log].reverse().find((e) => e.action.type === 'effectStep');

describe('★サーバーが効果を最後まで回す', () => {
  it('博士の研究（手札を全部トラッシュ → 7枚引く）が1回の操作で通る', () => {
    const { room, alice } = seatedRoom();
    const before = zone(room, alice, 'hand');
    expect(before).toHaveLength(5);

    const ops: Op[] = [
      { op: 'discard', from: 'hand', owner: 'self', count: 'all', chooser: 'self' },
      { op: 'draw', player: 'self', count: 7 },
    ];
    room.submitAction(alice, {
      type: 'startEffect',
      executionId: 'e1',
      ops,
      source: sourceOf(alice),
    });

    // startEffect を投げただけで、応答待ちがないので最後まで進む
    expect(room.rawState.execution).toBeNull();
    expect(zone(room, alice, 'discard')).toEqual(before);
    expect(zone(room, alice, 'hand')).toHaveLength(7);
    expect(zone(room, alice, 'deck')).toHaveLength(60 - 5 - 7);
  });

  it('人に聞く必要があるところで止まり、それ以上は進めない', () => {
    const { room, alice } = seatedRoom();
    room.submitAction(alice, {
      type: 'startEffect',
      executionId: 'e2',
      ops: [{ op: 'discard', from: 'hand', owner: 'self', count: 2, chooser: 'self' }],
      source: sourceOf(alice),
    });

    const choice = room.rawState.execution?.pendingChoice;
    expect(choice?.kind).toBe('selectCards');
    expect(choice?.candidates).toHaveLength(5);
    expect(zone(room, alice, 'discard')).toEqual([]);
  });

  it('打ち切れば卓は元に戻る（固まらない）', () => {
    const { room, alice } = seatedRoom();
    room.submitAction(alice, {
      type: 'startEffect',
      executionId: 'e3',
      ops: [{ op: 'manual', prompt: '手で処理してください' }],
      source: sourceOf(alice),
    });
    expect(room.rawState.execution?.pendingChoice?.prompt).toBe('手で処理してください');

    room.submitAction(alice, { type: 'cancelEffect', reason: '手で処理した' });
    expect(room.rawState.execution).toBeNull();
  });

  it('状況が変わらないトレーナーズ効果は警告するが、卓を止めない（T29）', () => {
    const { room, alice } = seatedRoom();
    const item = cardPool.find((card) => card.supertype === 'trainer' && card.trainerKind === 'item');
    const sourceCard = Object.values(room.rawState.cards).find(
      (card) => card.ownerId === alice && card.functionalId === item?.functionalId,
    );
    expect(item).toBeDefined();
    expect(sourceCard).toBeDefined();

    room.submitAction(alice, {
      type: 'startEffect',
      executionId: 'e-no-change',
      ops: [
        {
          op: 'heal',
          target: {
            kind: 'choose',
            player: 'self',
            chooser: 'self',
            filter: { hasDamage: true },
          },
          amount: 30,
        },
      ],
      source: { instanceId: sourceCard!.instanceId, playerId: alice, label: item!.name },
    });

    const start = room.rawState.log.find(
      (entry) => entry.action.type === 'startEffect' && entry.action.executionId === 'e-no-change',
    );
    expect(start?.warnings[0]?.code).toBe('EFFECT_NO_CHANGE');
    // 警告でブロックせず、空振りの効果を最後まで畳める。
    expect(room.rawState.execution).toBeNull();
  });
});

describe('★乱数はサーバーが決めて Action に載る（§4.2）', () => {
  it('効果の中のシャッフルで山札の並びが変わり、その並びがログに残る', () => {
    const { room, alice } = seatedRoom();
    const before = zone(room, alice, 'deck');

    room.submitAction(alice, {
      type: 'startEffect',
      executionId: 'e4',
      ops: [{ op: 'shuffle', zone: 'deck', owner: 'self' }],
      source: sourceOf(alice),
    });

    const after = zone(room, alice, 'deck');
    expect(after).toHaveLength(before.length);
    expect(after).not.toEqual(before);
    expect([...after].sort()).toEqual([...before].sort());

    const stepEntry = lastEffectStep(room.rawState.log);
    expect(stepEntry?.action.type).toBe('effectStep');
    if (stepEntry?.action.type === 'effectStep') {
      expect(stepEntry.action.rolls?.order).toEqual(after);
    }
    // 再現用の seed も載っている
    expect(stepEntry?.seed).toBeTruthy();
  });

  it('★シャッフルの並びはクライアントには渡さない（自分の山札でも）', () => {
    const { room, alice } = seatedRoom();
    room.submitAction(alice, {
      type: 'startEffect',
      executionId: 'e5',
      ops: [{ op: 'shuffle', zone: 'deck', owner: 'self' }],
      source: sourceOf(alice),
    });

    const seen = room.stateFor(alice);
    const entry = lastEffectStep(seen.log);
    if (entry?.action.type === 'effectStep') {
      expect(entry.action.rolls?.order?.every((id: string) => id === '?')).toBe(true);
    }
    expect(entry?.seed).toBeUndefined();
  });
});

describe('★保存・再接続・再生のどれを通しても同じ盤面になる', () => {
  const ops: Op[] = [
    { op: 'draw', player: 'self', count: 2 },
    { op: 'shuffle', zone: 'deck', owner: 'self' },
    { op: 'discard', from: 'hand', owner: 'self', count: 'all', chooser: 'self' },
    { op: 'draw', player: 'self', count: 6 },
  ];

  it('ログから再生すると同じ盤面になる', () => {
    const { room, alice } = seatedRoom();
    room.submitAction(alice, {
      type: 'startEffect',
      executionId: 'e6',
      ops,
      source: sourceOf(alice),
    });

    const replayed = room.replayFromLog();
    expect(replayed.cards).toEqual(room.rawState.cards);
    expect(replayed.execution).toEqual(room.rawState.execution);
  });

  it('応答待ちの途中で JSON にして戻しても、待っている内容がそのまま残る', () => {
    const { room, alice } = seatedRoom();
    room.submitAction(alice, {
      type: 'startEffect',
      executionId: 'e7',
      ops: [
        { op: 'draw', player: 'self', count: 1 },
        { op: 'discard', from: 'hand', owner: 'self', count: 3, chooser: 'self' },
        { op: 'draw', player: 'self', count: 2 },
      ],
      source: sourceOf(alice),
    });

    const live = room.rawState;
    expect(live.execution?.pendingChoice).not.toBeNull();

    const restored = JSON.parse(JSON.stringify(live)) as typeof live;
    expect(restored.execution).toEqual(live.execution);
    expect(restored.execution?.cursor).toBe(1);
    // 残りのオペコードも保たれている
    expect(restored.execution?.ops).toHaveLength(3);
  });
});
