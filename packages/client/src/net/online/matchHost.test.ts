/**
 * T48: ホストのブラウザが卓を持つ中継。
 *
 * ★いちばん守りたいのは「席の乗っ取りが起きないこと」。
 *   公開インターネットに出す以上、コードを知っているだけでは相手の席に座れてはいけない。
 *   身元は Firebase の UID だけが決める。
 */
import { describe, expect, it, vi } from 'vitest';
import type { GameState, PlayerId } from '@pokeca/shared';
import { MatchHost } from './matchHost';
import type { MatchEngine, Relay, RelayIntent, Seat } from './relay';

/** 卓の代わり。誰が何を要求したかだけ記録する */
function fakeEngine() {
  const calls: { actorId: PlayerId; kind: string; body: unknown }[] = [];
  let next = 0;
  const engine: MatchEngine = {
    join: (displayName) => {
      next += 1;
      calls.push({ actorId: `p-${next}`, kind: 'join', body: displayName });
      return { playerId: `p-${next}` };
    },
    submitIntent: (actorId, intent) => {
      if ((intent as { type: string }).type === 'boom') throw new Error('卓が断りました');
      calls.push({ actorId, kind: 'intent', body: intent });
    },
    submitAction: (actorId, action) => {
      calls.push({ actorId, kind: 'action', body: action });
    },
    stateFor: (playerId) => ({ viewerId: playerId }) as unknown as GameState,
  };
  return { engine, calls };
}

function fakeRelay() {
  const published: { uid: string; state: GameState }[] = [];
  const notices: { uid: string; message: string; seq: number }[] = [];
  const seats: Seat[][] = [];
  const acked: string[] = [];
  let handler: ((intent: RelayIntent) => void) | null = null;
  const relay: Relay = {
    publishState: async (uid, state) => {
      published.push({ uid, state });
    },
    publishNotice: async (uid, notice) => {
      notices.push({ uid, ...notice });
    },
    publishSeats: async (list) => {
      seats.push([...list]);
    },
    onIntent: (fn) => {
      handler = fn;
      return () => {
        handler = null;
      };
    },
    ackIntent: async (id) => {
      acked.push(id);
    },
  };
  return { relay, published, notices, seats, acked, deliver: (i: RelayIntent) => handler?.(i) };
}

const setup = () => {
  const { engine, calls } = fakeEngine();
  const relay = fakeRelay();
  const host = new MatchHost({
    engine,
    relay: relay.relay,
    hostUid: 'uid-host',
    hostName: 'ホスト',
  });
  host.start();
  return { host, calls, ...relay };
};

const intent = (uid: string, type: string): RelayIntent => ({
  id: `i-${type}-${uid}`,
  uid,
  body: { kind: 'intent', intent: { type } as never },
});

describe('席', () => {
  it('ホストは作ったときに座っている', () => {
    const { host } = setup();
    expect(host.seatOf('uid-host')?.playerId).toBe('p-1');
  });

  it('ゲストが座ると席が配られ、盤面が両方に届く', async () => {
    const { host, published, seats } = setup();
    const seat = await host.seat('uid-guest', 'ゲスト');

    expect(seat?.playerId).toBe('p-2');
    expect(seats.at(-1)?.map((s) => s.uid)).toEqual(['uid-host', 'uid-guest']);
    // ★人ごとに、その人の見え方で配る
    expect(published.map((p) => p.uid)).toEqual(['uid-host', 'uid-guest']);
  });

  it('★同じUIDならもとの席に戻る（再接続で席が増えない）', async () => {
    const { host } = setup();
    const first = await host.seat('uid-guest', 'ゲスト');
    const again = await host.seat('uid-guest', 'ゲスト（別端末）');
    expect(again).toEqual(first);
    expect(host.seatList).toHaveLength(2);
  });

  it('3人目は座れない', async () => {
    const { host } = setup();
    await host.seat('uid-guest', 'ゲスト');
    expect(await host.seat('uid-other', '横入り')).toBeNull();
    expect(host.rejected.at(-1)?.reason).toContain('席が埋まっています');
  });
});

describe('★席の乗っ取りを止める', () => {
  it('席のないUIDからの要求は捨てる', async () => {
    const { host, calls, deliver, acked } = setup();
    await host.seat('uid-guest', 'ゲスト');

    deliver(intent('uid-nanashi', 'endTurn'));
    await vi.waitFor(() => expect(acked).toContain('i-endTurn-uid-nanashi'));

    // ★卓には1件も届いていない
    expect(calls.filter((c) => c.kind === 'intent')).toHaveLength(0);
    expect(host.rejected.at(-1)?.reason).toBe('席がありません');
  });

  it('★操作の playerId は席から引いた値で上書きする', async () => {
    const { host, calls, deliver } = setup();
    await host.seat('uid-guest', 'ゲスト');

    // ゲストが「ホストのポケモンを動かす」形の操作を送ってきた
    deliver({
      id: 'i-forge',
      uid: 'uid-guest',
      body: {
        kind: 'action',
        action: { type: 'adjustDamage', playerId: 'p-1', slotId: 'active', delta: 9 } as never,
      },
    });

    await vi.waitFor(() => expect(calls.some((c) => c.kind === 'action')).toBe(true));
    const applied = calls.find((c) => c.kind === 'action')!;
    // ★送られてきた p-1 ではなく、席の p-2 に直っている
    expect((applied.body as { playerId: string }).playerId).toBe('p-2');
    expect(applied.actorId).toBe('p-2');
  });
});

describe('中継が止まらないこと', () => {
  it('★卓が断っても、理由を残して次へ進む', async () => {
    const { host, deliver, acked, published } = setup();
    await host.seat('uid-guest', 'ゲスト');
    const before = published.length;

    deliver(intent('uid-guest', 'boom'));
    await vi.waitFor(() => expect(acked).toContain('i-boom-uid-guest'));

    expect(host.rejected.at(-1)?.reason).toBe('卓が断りました');
    // ★断ったあとも盤面は配り直す（画面が固まらないように）
    expect(published.length).toBeGreaterThan(before);
  });

  it('★断った理由は断られた本人に送る（T49）', async () => {
    const { host, deliver, notices } = setup();
    await host.seat('uid-guest', 'ゲスト');

    deliver(intent('uid-guest', 'boom'));
    await vi.waitFor(() => expect(notices).toHaveLength(1));
    expect(notices[0]).toMatchObject({ uid: 'uid-guest', message: '卓が断りました' });
  });

  it('知らせには番号がついていて、増えていく（同じ知らせを二度出さないため）', async () => {
    const { host, deliver, notices } = setup();
    await host.seat('uid-guest', 'ゲスト');

    deliver(intent('uid-guest', 'boom'));
    deliver({ ...intent('uid-guest', 'boom'), id: 'i-boom-2' });
    await vi.waitFor(() => expect(notices).toHaveLength(2));
    expect(notices[1]!.seq).toBeGreaterThan(notices[0]!.seq);
  });

  it('ホスト自身には知らせを送らない（画面に直接出るので二重になる）', async () => {
    const { host, notices } = setup();
    await host.applyOwn('uid-host', { kind: 'intent', intent: { type: 'boom' } as never });
    expect(notices).toEqual([]);
    expect(host.rejected.at(-1)?.reason).toBe('卓が断りました');
  });

  it('処理した要求は片づける（同じ操作が二度流れない）', async () => {
    const { host, deliver, acked } = setup();
    await host.seat('uid-guest', 'ゲスト');
    deliver(intent('uid-guest', 'endTurn'));
    await vi.waitFor(() => expect(acked).toEqual(['i-endTurn-uid-guest']));
  });

  it('ホスト自身の操作は中継を通さない', async () => {
    const { host, calls, acked } = setup();
    await host.applyOwn('uid-host', { kind: 'intent', intent: { type: 'endTurn' } as never });
    expect(calls.some((c) => c.kind === 'intent' && c.actorId === 'p-1')).toBe(true);
    expect(acked).toEqual([]);
  });
});
