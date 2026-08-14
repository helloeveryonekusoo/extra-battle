/**
 * WebSocket の配線（T6）。
 *
 * 責務は3つだけ:
 *   1. メッセージを読んで Room に渡す
 *   2. 状態が変わったら、両者へ **それぞれの可視性でフィルタした** 状態を送る
 *   3. 在席状況を配る
 *
 * 前提: Tailscale などのプライベートネットワーク上で動かす（§2-7）。
 * 公開インターネットへ出す設計にはしない。
 */
import { WebSocketServer, type WebSocket } from 'ws';
import {
  decode,
  encode,
  PROTOCOL_VERSION,
  type ClientMessage,
  type PlayerId,
  type ServerMessage,
  type SubmittedDeck,
} from '@pokeca/shared';
import type { Room } from './room';
import { RoomRegistry } from './rooms';
import { loadCardTexts } from './cardStore';
import { appendGameLog } from './gameLog';
import {
  loadRoomStates,
  ROOM_STATE_DIR,
  saveAllRoomStates,
  saveRoomState,
} from './roomPersistence';

interface Session {
  room?: Room;
  playerId?: PlayerId;
}

export interface ServerHandle {
  wss: WebSocketServer;
  registry: RoomRegistry;
  close: () => Promise<void>;
}

export interface ServerOptions {
  /** テストでは一時フォルダへ差し替えられる。 */
  roomStateDirectory?: string;
  persistenceIntervalMs?: number;
}

export function startServer(
  port: number,
  host = '0.0.0.0',
  options: ServerOptions = {},
): ServerHandle {
  const cardPool = loadCardTexts();
  const registry = new RoomRegistry(cardPool);
  const roomStateDirectory = options.roomStateDirectory ?? ROOM_STATE_DIR;

  try {
    for (const saved of loadRoomStates(roomStateDirectory)) registry.restore(saved);
    if (registry.size > 0) console.log(`[rooms] ${registry.size}卓を復元しました`);
  } catch (error) {
    // 保存の不調で、新しい対戦まで起動できなくしない。
    console.error('[rooms] 復元に失敗しました', error);
  }

  const wss = new WebSocketServer({ port, host });
  const sessions = new Map<WebSocket, Session>();

  const persistRoom = (room: Room): void => {
    try {
      saveRoomState(room, roomStateDirectory);
    } catch (error) {
      console.error(`[rooms] ${room.code} の保存に失敗しました`, error);
    }
  };

  const persistAll = (): void => {
    try {
      saveAllRoomStates(registry, roomStateDirectory);
    } catch (error) {
      console.error('[rooms] 定期保存に失敗しました', error);
    }
  };

  const persistenceTimer = setInterval(persistAll, options.persistenceIntervalMs ?? 5_000);
  persistenceTimer.unref();

  const send = (socket: WebSocket, message: ServerMessage): void => {
    if (socket.readyState === socket.OPEN) socket.send(encode(message));
  };

  const fail = (socket: WebSocket, message: string): void => {
    send(socket, { type: 'error', message });
  };

  /** 卓にいる全員へ、その人向けにフィルタした状態を配る */
  const broadcastState = (room: Room): void => {
    for (const [socket, session] of sessions) {
      if (session.room === room && session.playerId) {
        send(socket, { type: 'state', state: room.stateFor(session.playerId) });
      }
    }
  };

  const broadcastPresence = (room: Room): void => {
    for (const [socket, session] of sessions) {
      if (session.room === room) send(socket, { type: 'presence', players: room.presence });
    }
  };

  const enter = (
    socket: WebSocket,
    room: Room,
    displayName: string,
    playerId?: PlayerId,
    deck?: SubmittedDeck,
  ): void => {
    const seat = room.join(displayName, playerId, deck);
    sessions.set(socket, { room, playerId: seat.playerId });
    persistRoom(room);
    send(socket, {
      type: 'joined',
      roomCode: room.code,
      playerId: seat.playerId,
      cards: [...room.cardPool],
    });
    broadcastPresence(room);
    broadcastState(room);
  };

  wss.on('connection', (socket) => {
    sessions.set(socket, {});
    send(socket, { type: 'hello', protocolVersion: PROTOCOL_VERSION });

    socket.on('message', (raw) => {
      const message = decode<ClientMessage>(raw.toString());
      if (!message) return fail(socket, 'メッセージを読めませんでした');

      const session = sessions.get(socket) ?? {};

      try {
        switch (message.type) {
          case 'ping':
            return send(socket, { type: 'pong' });

          case 'createRoom': {
            const room = registry.create();
            console.log(`[room] created ${room.code}`);
            return enter(socket, room, message.displayName, undefined, message.deck);
          }

          case 'joinRoom': {
            const room = registry.get(message.roomCode);
            if (!room) return fail(socket, 'その部屋コードは見つかりません');
            return enter(socket, room, message.displayName, message.playerId, message.deck);
          }

          case 'action': {
            if (!session.room || !session.playerId) return fail(socket, 'まだ部屋にいません');
            session.room.submitAction(session.playerId, message.action);
            appendGameLog(session.room);
            persistRoom(session.room);
            return broadcastState(session.room);
          }

          case 'intent': {
            if (!session.room || !session.playerId) return fail(socket, 'まだ部屋にいません');
            session.room.submitIntent(session.playerId, message.intent);
            appendGameLog(session.room);
            persistRoom(session.room);
            return broadcastState(session.room);
          }
        }
      } catch (error) {
        return fail(socket, error instanceof Error ? error.message : '不明なエラー');
      }
    });

    socket.on('close', () => {
      const session = sessions.get(socket);
      sessions.delete(socket);
      if (session?.room && session.playerId) {
        session.room.disconnect(session.playerId);
        persistRoom(session.room);
        broadcastPresence(session.room);
      }
    });
  });

  return {
    wss,
    registry,
    close: () => {
      clearInterval(persistenceTimer);
      persistAll();
      return new Promise<void>((resolve, reject) => {
        for (const socket of sessions.keys()) socket.terminate();
        wss.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
