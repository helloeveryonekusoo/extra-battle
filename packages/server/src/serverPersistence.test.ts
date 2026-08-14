import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  cardsInZone,
  decode,
  encode,
  type ClientMessage,
  type ServerMessage,
} from '@pokeca/shared';
import { startServer, type ServerHandle } from './server';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class RestartClient {
  readonly received: ServerMessage[] = [];
  private readonly socket: WebSocket;
  private readonly waiters: {
    match: (message: ServerMessage) => boolean;
    resolve: (message: ServerMessage) => void;
  }[] = [];

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}`);
    this.socket.on('message', (raw) => {
      const message = decode<ServerMessage>(raw.toString());
      if (!message) return;
      this.received.push(message);
      for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
        const waiter = this.waiters[i]!;
        if (!waiter.match(message)) continue;
        this.waiters.splice(i, 1);
        waiter.resolve(message);
      }
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
  }

  send(message: ClientMessage): void {
    this.socket.send(encode(message));
  }

  wait<T extends ServerMessage>(match: (message: ServerMessage) => message is T): Promise<T> {
    const found = this.received.find(match);
    if (found) return Promise.resolve(found);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('メッセージが届きませんでした')), 3_000);
      this.waiters.push({
        match,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message as T);
        },
      });
    });
  }

  close(): void {
    this.socket.close();
  }
}

const isJoined = (
  message: ServerMessage,
): message is Extract<ServerMessage, { type: 'joined' }> => message.type === 'joined';
const isError = (
  message: ServerMessage,
): message is Extract<ServerMessage, { type: 'error' }> => message.type === 'error';

async function listeningPort(handle: ServerHandle): Promise<number> {
  if (!handle.wss.address()) {
    await new Promise<void>((resolve) => handle.wss.once('listening', resolve));
  }
  return (handle.wss.address() as AddressInfo).port;
}

describe('サーバー再起動後の再接続', () => {
  it('同じ部屋コードとプレイヤーIDで盤面を復元し、両者が戻るまで操作を止める', async () => {
    const roomStateDirectory = mkdtempSync(join(tmpdir(), 'pokeca-restart-test-'));
    temporaryDirectories.push(roomStateDirectory);

    const firstServer = startServer(0, '127.0.0.1', { roomStateDirectory });
    const firstPort = await listeningPort(firstServer);
    const firstAlice = new RestartClient(firstPort);
    await firstAlice.open();
    firstAlice.send({ type: 'createRoom', displayName: 'アリス' });
    const joinedAlice = await firstAlice.wait(isJoined);

    const firstBob = new RestartClient(firstPort);
    await firstBob.open();
    firstBob.send({ type: 'joinRoom', roomCode: joinedAlice.roomCode, displayName: 'ボブ' });
    const joinedBob = await firstBob.wait(isJoined);

    firstAlice.send({
      type: 'intent',
      intent: { type: 'devDealSampleDeck', playerId: joinedAlice.playerId, size: 20 },
    });
    await firstAlice.wait(
      (message): message is Extract<ServerMessage, { type: 'state' }> =>
        message.type === 'state' &&
        cardsInZone(message.state, joinedAlice.playerId, 'deck').length === 20,
    );

    await firstServer.close();

    const secondServer = startServer(0, '127.0.0.1', { roomStateDirectory });
    const secondPort = await listeningPort(secondServer);
    expect(secondServer.registry.get(joinedAlice.roomCode)?.presence.every((seat) => !seat.connected)).toBe(true);

    const secondAlice = new RestartClient(secondPort);
    await secondAlice.open();
    secondAlice.send({
      type: 'joinRoom',
      roomCode: joinedAlice.roomCode,
      displayName: 'アリス',
      playerId: joinedAlice.playerId,
    });
    expect((await secondAlice.wait(isJoined)).playerId).toBe(joinedAlice.playerId);
    await secondAlice.wait(
      (message): message is Extract<ServerMessage, { type: 'state' }> =>
        message.type === 'state' &&
        cardsInZone(message.state, joinedAlice.playerId, 'deck').length === 20,
    );

    secondAlice.send({
      type: 'intent',
      intent: { type: 'drawCards', playerId: joinedAlice.playerId, count: 1 },
    });
    expect((await secondAlice.wait(isError)).message).toContain('相手が切断中');

    const secondBob = new RestartClient(secondPort);
    await secondBob.open();
    secondBob.send({
      type: 'joinRoom',
      roomCode: joinedAlice.roomCode,
      displayName: 'ボブ',
      playerId: joinedBob.playerId,
    });
    expect((await secondBob.wait(isJoined)).playerId).toBe(joinedBob.playerId);
    await secondAlice.wait(
      (message): message is Extract<ServerMessage, { type: 'presence' }> =>
        message.type === 'presence' && message.players.length === 2 && message.players.every((seat) => seat.connected),
    );

    secondAlice.send({
      type: 'intent',
      intent: { type: 'drawCards', playerId: joinedAlice.playerId, count: 1 },
    });
    await secondAlice.wait(
      (message): message is Extract<ServerMessage, { type: 'state' }> =>
        message.type === 'state' &&
        cardsInZone(message.state, joinedAlice.playerId, 'hand').length === 1,
    );

    secondAlice.send({
      type: 'intent',
      intent: { type: 'flipCoin', playerId: joinedAlice.playerId, count: 1 },
    });
    await secondAlice.wait(
      (message): message is Extract<ServerMessage, { type: 'state' }> =>
        message.type === 'state' && message.state.log.at(-1)?.action.type === 'flipCoin',
    );
    expect(secondServer.registry.get(joinedAlice.roomCode)?.rawState.log.at(-1)?.seed).toMatch(
      /:2$/,
    );

    secondAlice.close();
    secondBob.close();
    firstAlice.close();
    firstBob.close();
    await secondServer.close();
  });
});
