/**
 * 進行中の卓をJSONへ保存し、サーバー起動時に読み戻す。
 * 対戦ログとは別ファイルにして、現在状態・乱数位置・Undo履歴をまとめて保つ。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameState } from '@pokeca/shared';
import type { PersistedRoomState, Room } from './room';
import type { RoomRegistry } from './rooms';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOM_STATE_DIR = resolve(here, '../../../logs/rooms');

function isGameState(value: unknown): value is GameState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<GameState>;
  return (
    typeof state.gameId === 'string' &&
    typeof state.rngSeed === 'string' &&
    Array.isArray(state.log) &&
    Boolean(state.players && typeof state.players === 'object')
  );
}

function isPersistedRoomState(value: unknown): value is PersistedRoomState {
  if (!value || typeof value !== 'object') return false;
  const saved = value as Partial<PersistedRoomState>;
  return (
    saved.version === 1 &&
    typeof saved.savedAt === 'string' &&
    typeof saved.code === 'string' &&
    /^[A-Z0-9]{6}$/.test(saved.code) &&
    typeof saved.rngSeed === 'string' &&
    Number.isSafeInteger(saved.rngDrawn) &&
    Number.isSafeInteger(saved.instanceCounter) &&
    Array.isArray(saved.seats) &&
    saved.seats.every(
      (seat) =>
        Boolean(seat) &&
        typeof seat.playerId === 'string' &&
        typeof seat.displayName === 'string',
    ) &&
    isGameState(saved.state) &&
    saved.state.rngSeed === saved.rngSeed &&
    Array.isArray(saved.snapshots) &&
    saved.snapshots.every(
      (snapshot) =>
        Boolean(snapshot) && Number.isSafeInteger(snapshot.seq) && isGameState(snapshot.state),
    )
  );
}

export function saveRoomState(room: Room, directory = ROOM_STATE_DIR): void {
  mkdirSync(directory, { recursive: true });
  const target = resolve(directory, `${room.code}.json`);
  writeFileSync(target, JSON.stringify(room.toPersistedState(), null, 2), 'utf8');
}

export function saveAllRoomStates(registry: RoomRegistry, directory = ROOM_STATE_DIR): void {
  for (const room of registry.all) saveRoomState(room, directory);
}

export function loadRoomStates(directory = ROOM_STATE_DIR): PersistedRoomState[] {
  if (!existsSync(directory)) return [];

  const restored: PersistedRoomState[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(resolve(directory, name), 'utf8'));
      if (!isPersistedRoomState(parsed)) {
        console.error(`[rooms] 保存ファイルの形式が不正です: ${name}`);
        continue;
      }
      restored.push(parsed);
    } catch (error) {
      console.error(`[rooms] 保存ファイルを読めませんでした: ${name}`, error);
    }
  }
  return restored;
}
