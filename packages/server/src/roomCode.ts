import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@pokeca/shared';
import { randomInt } from 'node:crypto';

/** ルームコードを生成する。乱数はすべてサーバー側で作る（§4.2）。 */
export function generateRoomCode(length: number = ROOM_CODE_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return out;
}
