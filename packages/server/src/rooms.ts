/** ルームの台帳。起動時にJSONから復元した卓もここへ戻す。 */
import { randomUUID } from 'node:crypto';
import type { CardText } from '@pokeca/shared';
import { Room, type PersistedRoomState } from './room';
import { generateRoomCode } from './roomCode';

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();

  constructor(private readonly cardPool: readonly CardText[]) {}

  get size(): number {
    return this.rooms.size;
  }

  get all(): readonly Room[] {
    return [...this.rooms.values()];
  }

  create(): Room {
    let code = generateRoomCode();
    while (this.rooms.has(code)) code = generateRoomCode();

    const room = new Room({ code, rngSeed: randomUUID(), cardPool: this.cardPool });
    this.rooms.set(code, room);
    return room;
  }

  restore(saved: PersistedRoomState): Room {
    const room = new Room({
      code: saved.code,
      rngSeed: saved.rngSeed,
      cardPool: this.cardPool,
      restored: saved,
    });
    this.rooms.set(room.code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code.trim().toUpperCase());
  }

  /** 終了済みで誰もいない卓だけを片付ける。進行中の卓は再接続用に残す。 */
  reap(): void {
    for (const [code, room] of this.rooms) {
      if (room.rawState.phase === 'ended' && !room.hasAnyoneConnected) this.rooms.delete(code);
    }
  }
}
