/**
 * T48: ホストとゲストを繋いだ通しの試験。
 *
 * ★本物の Firestore は使わない。RoomsApi を差し替えて、
 *   「部屋を建てる → 入る → 席が配られる → 操作が届いて盤面が返る」を全部ここで確かめる。
 *
 * ★いちばん守りたいのは、通信の形を変えても **可視性フィルタが効いていること**。
 *   第2段階のサーバーからホストのブラウザへ卓を移したので、ここが崩れていないか確かめる。
 */
import { describe, expect, it, vi } from 'vitest';
import type { GameState, SubmittedDeck } from '@pokeca/shared';
import { sampleCardIndex } from '../../cards/sampleCards';
import {
  hostOnlineRoom,
  joinOnlineRoom,
  type OnlineHandlers,
  type SeatPresence,
} from './session';
import type { Relay, RelayIntent, Seat } from './relay';
import type { RoomDoc, RoomsApi, StateUpdate } from './rooms';

/** 記憶の中だけの部屋。Firestore の代わり */
function fakeRooms() {
  const rooms = new Map<string, RoomDoc>();
  /** ★本物と同じく、盤面と知らせは1つの書類に重ねる */
  const states = new Map<string, StateUpdate>();
  const roomWatchers = new Map<string, ((room: RoomDoc | null) => void)[]>();
  const stateWatchers = new Map<string, ((update: StateUpdate) => void)[]>();
  const intentHandlers = new Map<string, (intent: RelayIntent) => void>();
  let counter = 0;

  const notify = (code: string): void => {
    const room = rooms.get(code);
    for (const watcher of roomWatchers.get(code) ?? []) {
      watcher(room ? structuredClone(room) : null);
    }
  };

  const api: RoomsApi = {
    create: async (hostUid, hostName) => {
      const code = `ROOM${rooms.size + 1}`;
      rooms.set(code, { code, hostUid, hostName, members: [hostUid], seats: {}, guests: {} });
      return code;
    },
    read: async (code) => rooms.get(code) ?? null,
    join: async (code, uid, profile) => {
      const room = rooms.get(code);
      if (!room) throw new Error('部屋がありません');
      if (!room.members.includes(uid)) room.members.push(uid);
      room.guests[uid] = profile;
      notify(code);
    },
    watch: (code, onChange) => {
      const list = roomWatchers.get(code) ?? [];
      list.push(onChange);
      roomWatchers.set(code, list);
      const room = rooms.get(code);
      onChange(room ? structuredClone(room) : null);
      return () => {
        roomWatchers.set(code, (roomWatchers.get(code) ?? []).filter((w) => w !== onChange));
      };
    },
    watchState: (code, uid, onUpdate) => {
      const key = `${code}:${uid}`;
      const list = stateWatchers.get(key) ?? [];
      list.push(onUpdate);
      stateWatchers.set(key, list);
      const current = states.get(key);
      if (current) onUpdate(current);
      return () => {
        stateWatchers.set(key, (stateWatchers.get(key) ?? []).filter((w) => w !== onUpdate));
      };
    },
    sendIntent: async (code, uid, body) => {
      counter += 1;
      intentHandlers.get(code)?.({ id: `i-${counter}`, uid, body });
    },
    close: async (code) => {
      rooms.delete(code);
      notify(code);
    },
    relay: (code): Relay => ({
      publishState: async (uid, state) => {
        const key = `${code}:${uid}`;
        const merged: StateUpdate = { ...states.get(key), state };
        states.set(key, merged);
        for (const watcher of stateWatchers.get(key) ?? []) watcher(merged);
      },
      publishNotice: async (uid, notice) => {
        const key = `${code}:${uid}`;
        const merged: StateUpdate = { ...states.get(key), notice };
        states.set(key, merged);
        for (const watcher of stateWatchers.get(key) ?? []) watcher(merged);
      },
      publishSeats: async (seats: readonly Seat[]) => {
        const room = rooms.get(code);
        if (!room) return;
        room.seats = Object.fromEntries(seats.map((seat) => [seat.uid, seat.playerId]));
        notify(code);
      },
      onIntent: (handler) => {
        intentHandlers.set(code, handler);
        return () => intentHandlers.delete(code);
      },
      ackIntent: async () => {},
    }),
  };

  return { api, rooms };
}

function recorder() {
  const states: GameState[] = [];
  const seats: { seats: readonly SeatPresence[]; playerId: string | null }[] = [];
  const errors: string[] = [];
  const handlers: OnlineHandlers = {
    onState: (state) => states.push(state),
    onSeats: (list, playerId) => seats.push({ seats: list, playerId }),
    onError: (message) => errors.push(message),
  };
  return { handlers, states, seats, errors, last: () => states.at(-1) };
}

const cardPool = sampleCardIndex.all;
const deckOf = (name: string): SubmittedDeck => ({
  name,
  cards: [{ functionalId: cardPool[0]!.functionalId, count: 8 }],
});

/** ホストとゲストを繋いだところまで用意する */
async function connected(guestDeck?: SubmittedDeck) {
  const { api } = fakeRooms();
  const hostSide = recorder();
  const guestSide = recorder();

  const host = await hostOnlineRoom({
    uid: 'uid-host',
    displayName: 'ホスト',
    deck: deckOf('ホストデッキ'),
    cardPool,
    rooms: api,
    handlers: hostSide.handlers,
  });

  const guest = await joinOnlineRoom({
    code: host.code,
    uid: 'uid-guest',
    displayName: 'ゲスト',
    ...(guestDeck ? { deck: guestDeck } : {}),
    rooms: api,
    handlers: guestSide.handlers,
  });

  await vi.waitFor(() => expect(guestSide.seats.at(-1)?.playerId).toBe('p-2'));
  return { api, host, guest, hostSide, guestSide };
}

describe('部屋を建てて入る', () => {
  it('ホストは建てた時点で自分の盤面を受け取る（中継を通さない）', async () => {
    const { api } = fakeRooms();
    const hostSide = recorder();
    const host = await hostOnlineRoom({
      uid: 'uid-host',
      displayName: 'ホスト',
      cardPool,
      rooms: api,
      handlers: hostSide.handlers,
    });

    expect(host.role).toBe('host');
    expect(hostSide.last()).toBeTruthy();
    expect(hostSide.seats.at(-1)?.playerId).toBe('p-1');
  });

  it('ゲストが入ると席が配られ、盤面が届く', async () => {
    const { guestSide } = await connected();
    expect(guestSide.last()).toBeTruthy();
    expect(guestSide.seats.at(-1)?.seats.map((s) => s.displayName)).toEqual(['ホスト', 'ゲスト']);
  });

  it('ゲストの持ち込みデッキが卓に入る', async () => {
    const { guestSide } = await connected(deckOf('ゲストデッキ'));
    const state = guestSide.last()!;
    const mine = Object.values(state.cards).filter((c) => c.ownerId === 'p-2');
    expect(mine).toHaveLength(8);
  });

  it('ない部屋には入れない', async () => {
    const { api } = fakeRooms();
    await expect(
      joinOnlineRoom({
        code: 'NOPE',
        uid: 'uid-guest',
        displayName: 'ゲスト',
        rooms: api,
        handlers: recorder().handlers,
      }),
    ).rejects.toThrow('部屋がありません');
  });

  it('★3人目は座れず、理由がホストに出る', async () => {
    const { api, host, hostSide } = await connected();
    const outsider = recorder();
    await joinOnlineRoom({
      code: host.code,
      uid: 'uid-other',
      displayName: '横入り',
      rooms: api,
      handlers: outsider.handlers,
    });

    // ★黙って捨てず、ホストの画面に理由が出る
    await vi.waitFor(() => expect(hostSide.errors).toContain('席が埋まっています'));
    const room = await api.read(host.code);
    expect(Object.keys(room!.seats)).toEqual(['uid-host', 'uid-guest']);
    // 3人目には盤面が1枚も届かない
    expect(outsider.states).toEqual([]);
  });
});

describe('操作が往復する', () => {
  it('ゲストの操作がホストの卓に届き、両方の盤面が進む', async () => {
    const { guest, hostSide, guestSide } = await connected();
    const before = guestSide.last()!.log.length;

    guest.submitIntent({ type: 'flipCoin', playerId: 'p-2', count: 1 });

    await vi.waitFor(() => expect(guestSide.last()!.log.length).toBeGreaterThan(before));
    // ★ホスト側の画面も同じ操作で進む
    expect(hostSide.last()!.log.some((entry) => entry.action.type === 'flipCoin')).toBe(true);
  });

  it('ホスト自身の操作も同じ卓に入る', async () => {
    const { host, hostSide, guestSide } = await connected();
    host.submitIntent({ type: 'flipCoin', playerId: 'p-1', count: 1 });

    await vi.waitFor(() =>
      expect(guestSide.last()!.log.some((e) => e.action.type === 'flipCoin')).toBe(true),
    );
    expect(hostSide.last()!.log.some((e) => e.action.type === 'flipCoin')).toBe(true);
  });

  it('★卓が断っても中継は止まらない', async () => {
    const { guest, hostSide, guestSide } = await connected();
    // 山札のないプレイヤーで引こうとする（卓が断る）
    guest.submitIntent({ type: 'drawCards', playerId: 'p-2', count: 1 });
    await vi.waitFor(() => expect(hostSide.errors).toContain('山札にカードがありません'));

    // ★断られたあとも次の操作は普通に通る
    guest.submitIntent({ type: 'flipCoin', playerId: 'p-2', count: 1 });
    await vi.waitFor(() =>
      expect(guestSide.last()!.log.some((e) => e.action.type === 'flipCoin')).toBe(true),
    );
  });

  it('★断られた理由がゲスト自身にも届く（T49）', async () => {
    const { guest, guestSide } = await connected();
    guest.submitIntent({ type: 'drawCards', playerId: 'p-2', count: 1 });
    await vi.waitFor(() => expect(guestSide.errors).toContain('山札にカードがありません'));
  });

  it('同じ知らせは二度出さない', async () => {
    const { guest, guestSide } = await connected();
    guest.submitIntent({ type: 'drawCards', playerId: 'p-2', count: 1 });
    await vi.waitFor(() => expect(guestSide.errors).toHaveLength(1));

    // 知らせを持ったまま盤面だけが更新されても、もう一度は出ない
    guest.submitIntent({ type: 'flipCoin', playerId: 'p-2', count: 1 });
    await vi.waitFor(() =>
      expect(guestSide.last()!.log.some((e) => e.action.type === 'flipCoin')).toBe(true),
    );
    expect(guestSide.errors).toHaveLength(1);
  });
});

describe('★同じ人が入り直したとき（T49）', () => {
  it('席は増えず、最後の盤面がそのまま届く', async () => {
    const { api, host, guest } = await connected();
    guest.close();

    const again = recorder();
    await joinOnlineRoom({
      code: host.code,
      uid: 'uid-guest',
      displayName: 'ゲスト（別端末）',
      rooms: api,
      handlers: again.handlers,
    });

    await vi.waitFor(() => expect(again.seats.at(-1)?.playerId).toBe('p-2'));
    // ★卓を通さずに、置いてある自分あての盤面がそのまま読める
    expect(again.last()).toBeTruthy();
    const room = await api.read(host.code);
    expect(Object.keys(room!.seats)).toHaveLength(2);
  });
});

describe('★ホストが去ったとき（T49）', () => {
  it('部屋が消えるとゲストに伝わり、相手が切断中になる', async () => {
    const { host, guestSide } = await connected();
    host.close();

    await vi.waitFor(() => expect(guestSide.errors).toContain('ホストが対戦を終わりました'));
    const seats = guestSide.seats.at(-1)!;
    // ★自分の席は残し、相手を切断中にする（いつもの一時停止の見た目に合わせる）
    expect(seats.playerId).toBe('p-2');
    expect(seats.seats.find((s) => s.playerId === 'p-1')?.connected).toBe(false);
    expect(seats.seats.find((s) => s.playerId === 'p-2')?.connected).toBe(true);
  });
});

describe('★可視性フィルタが通信の形を変えても効いている', () => {
  it('ゲストにはホストの山札の中身が見えない', async () => {
    const { guestSide } = await connected();
    const state = guestSide.last()!;

    const hostDeck = Object.values(state.cards).filter(
      (card) => card.ownerId === 'p-1' && card.zone === 'deck',
    );
    expect(hostDeck.length).toBeGreaterThan(0);
    // 正体は伏せられ、instanceId も伏せ名に置き換わっている
    expect(hostDeck.every((card) => card.functionalId === '')).toBe(true);
    expect(hostDeck.every((card) => card.instanceId.startsWith('hidden-'))).toBe(true);
  });

  it('乱数の種は誰にも渡らない', async () => {
    const { hostSide, guestSide } = await connected();
    expect(guestSide.last()!.rngSeed).toBe('');
    expect(hostSide.last()!.rngSeed).toBe('');
  });
});
