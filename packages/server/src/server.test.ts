/**
 * T6 の完了条件を自動テストにしたもの。
 * 「2つのクライアントが接続し、片方の操作がもう片方に反映される」を実際の
 * WebSocket 越しに確かめる。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import {
  cardsInZone,
  encode,
  decode,
  findSlot,
  HIDDEN_FUNCTIONAL_ID,
  type ClientMessage,
  type GameState,
  type ServerMessage,
} from '@pokeca/shared';
import { startServer, type ServerHandle } from './server';

const PORT = 8899;
let handle: ServerHandle;
let roomStateDirectory: string;

/** サーバーからのメッセージを溜めつつ、条件に合うものを待てる小さなクライアント */
class TestClient {
  readonly socket: WebSocket;
  readonly received: ServerMessage[] = [];
  private waiters: { match: (m: ServerMessage) => boolean; resolve: (m: never) => void }[] = [];

  constructor() {
    this.socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
    this.socket.on('message', (raw) => {
      const message = decode<ServerMessage>(raw.toString());
      if (!message) return;
      this.received.push(message);
      this.waiters = this.waiters.filter((w) => {
        if (!w.match(message)) return true;
        (w.resolve as (m: ServerMessage) => void)(message);
        return false;
      });
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
  }

  send(message: ClientMessage): void {
    this.socket.send(encode(message));
  }

  /** 条件に合うメッセージを待つ。すでに届いていれば即返す */
  wait<T extends ServerMessage>(match: (m: ServerMessage) => m is T, timeoutMs = 3000): Promise<T> {
    const already = this.received.find(match);
    if (already) return Promise.resolve(already);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('メッセージが来ませんでした')), timeoutMs);
      this.waiters.push({
        match,
        resolve: ((m: T) => {
          clearTimeout(timer);
          resolve(m);
        }) as (m: never) => void,
      });
    });
  }

  /** 今の受信履歴を捨てて、次に届く状態だけを見る */
  clear(): void {
    this.received.length = 0;
  }

  close(): void {
    this.socket.close();
  }
}

const isJoined = (m: ServerMessage): m is Extract<ServerMessage, { type: 'joined' }> =>
  m.type === 'joined';
const isState = (m: ServerMessage): m is Extract<ServerMessage, { type: 'state' }> =>
  m.type === 'state';
const isError = (m: ServerMessage): m is Extract<ServerMessage, { type: 'error' }> =>
  m.type === 'error';

beforeAll(() => {
  roomStateDirectory = mkdtempSync(join(tmpdir(), 'pokeca-server-test-'));
  handle = startServer(PORT, '127.0.0.1', { roomStateDirectory });
});

afterAll(async () => {
  await handle.close();
  rmSync(roomStateDirectory, { recursive: true, force: true });
});

async function seatTwo(): Promise<{
  a: TestClient;
  b: TestClient;
  roomCode: string;
  aliceId: string;
  bobId: string;
}> {
  const a = new TestClient();
  await a.open();
  a.send({ type: 'createRoom', displayName: 'アリス' });
  const joinedA = await a.wait(isJoined);

  const b = new TestClient();
  await b.open();
  b.send({ type: 'joinRoom', roomCode: joinedA.roomCode, displayName: 'ボブ' });
  const joinedB = await b.wait(isJoined);

  return {
    a,
    b,
    roomCode: joinedA.roomCode,
    aliceId: joinedA.playerId,
    bobId: joinedB.playerId,
  };
}

describe('WebSocketサーバー', () => {
  it('接続すると hello が来る', async () => {
    const c = new TestClient();
    await c.open();
    const hello = await c.wait(
      (m): m is Extract<ServerMessage, { type: 'hello' }> => m.type === 'hello',
    );
    expect(hello.protocolVersion).toBe(1);
    c.close();
  });

  it('ルームを作って参加でき、カード定義が配られる', async () => {
    const { a, b, roomCode } = await seatTwo();
    expect(roomCode).toHaveLength(6);
    const joined = await b.wait(isJoined);
    expect(joined.cards.length).toBeGreaterThanOrEqual(38);
    a.close();
    b.close();
  });

  it('存在しない部屋コードは断られる', async () => {
    const c = new TestClient();
    await c.open();
    c.send({ type: 'joinRoom', roomCode: 'ZZZZZZ', displayName: 'だれか' });
    expect((await c.wait(isError)).message).toContain('見つかりません');
    c.close();
  });

  it('★片方の操作がもう片方に反映される', async () => {
    const { a, b, aliceId } = await seatTwo();

    // アリスがデッキを置いて1枚引き、そのカードをバトル場に出す
    a.send({ type: 'intent', intent: { type: 'devDealSampleDeck', playerId: aliceId, size: 20 } });
    a.send({ type: 'intent', intent: { type: 'drawCards', playerId: aliceId, count: 1 } });

    const afterDraw = await waitForState(a, (s) => cardsInZone(s, aliceId, 'hand').length === 1);
    const cardId = cardsInZone(afterDraw, aliceId, 'hand')[0]!.instanceId;

    b.clear();
    a.send({
      type: 'action',
      action: { type: 'placePokemon', playerId: aliceId, slotId: 'active', cardId },
    });
    a.send({
      type: 'action',
      action: { type: 'adjustDamage', playerId: aliceId, slotId: 'active', delta: 4 },
    });

    // ボブ側の画面にアリスの盤面が届いている
    const bobsView = await waitForState(
      b,
      (s) => findSlot(s, aliceId, 'active')?.damageCounters === 4,
    );
    expect(findSlot(bobsView, aliceId, 'active')?.stack).toEqual([cardId]);
    expect(bobsView.cards[cardId]?.functionalId).not.toBe(HIDDEN_FUNCTIONAL_ID);

    a.close();
    b.close();
  });

  it('★相手の手札の中身は届かない', async () => {
    const { a, b, aliceId } = await seatTwo();

    a.send({ type: 'intent', intent: { type: 'devDealSampleDeck', playerId: aliceId, size: 20 } });
    a.send({ type: 'intent', intent: { type: 'drawCards', playerId: aliceId, count: 7 } });

    const bobsView = await waitForState(b, (s) => cardsInZone(s, aliceId, 'hand').length === 7);
    expect(
      cardsInZone(bobsView, aliceId, 'hand').every((c) => c.functionalId === HIDDEN_FUNCTIONAL_ID),
    ).toBe(true);

    const alicesView = await waitForState(a, (s) => cardsInZone(s, aliceId, 'hand').length === 7);
    expect(
      cardsInZone(alicesView, aliceId, 'hand').every(
        (c) => c.functionalId !== HIDDEN_FUNCTIONAL_ID,
      ),
    ).toBe(true);

    a.close();
    b.close();
  });

  it('切断しても playerId を添えれば同じ席に戻れる', async () => {
    const { a, b, roomCode, aliceId } = await seatTwo();
    a.send({ type: 'intent', intent: { type: 'devDealSampleDeck', playerId: aliceId, size: 20 } });
    await waitForState(b, (s) => cardsInZone(s, aliceId, 'deck').length === 20);
    a.close();

    const again = new TestClient();
    await again.open();
    again.send({ type: 'joinRoom', roomCode, displayName: 'アリス', playerId: aliceId });
    const rejoined = await again.wait(isJoined);
    expect(rejoined.playerId).toBe(aliceId);

    const restored = await waitForState(again, (s) => cardsInZone(s, aliceId, 'deck').length === 20);
    expect(cardsInZone(restored, aliceId, 'deck')).toHaveLength(20);

    again.close();
    b.close();
  });

  it('部屋に入る前の操作は断られる', async () => {
    const c = new TestClient();
    await c.open();
    c.send({ type: 'action', action: { type: 'setPhase', phase: 'turn' } });
    expect((await c.wait(isError)).message).toContain('部屋');
    c.close();
  });
});

/** 条件を満たす state が来るまで待つ */
async function waitForState(
  client: TestClient,
  predicate: (state: GameState) => boolean,
): Promise<GameState> {
  const message = await client.wait(
    (m): m is Extract<ServerMessage, { type: 'state' }> => isState(m) && predicate(m.state),
  );
  return message.state;
}
