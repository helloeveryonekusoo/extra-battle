/**
 * 対戦ログの JSON 出力（§3 永続化: メモリ + JSONログのファイル出力。DBは使わない）。
 *
 * シードと Action の並びを丸ごと残すので、あとから対戦を再現できる（§4.2）。
 * ここに書き出すのは **サーバーが持つ完全な状態** なので、ファイルは外に出さないこと。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Room } from './room';

const here = dirname(fileURLToPath(import.meta.url));
export const LOG_DIR = resolve(here, '../../../logs');

let ready = false;

export function appendGameLog(room: Room): void {
  try {
    if (!ready) {
      mkdirSync(LOG_DIR, { recursive: true });
      ready = true;
    }
    const state = room.rawState;
    const payload = {
      gameId: state.gameId,
      roomCode: room.code,
      rngSeed: state.rngSeed,
      savedAt: new Date().toISOString(),
      log: state.log,
    };
    writeFileSync(resolve(LOG_DIR, `${room.code}.json`), JSON.stringify(payload, null, 2), 'utf8');
  } catch (error) {
    // ログの失敗で対戦を止めない
    console.error('[log] 書き出しに失敗しました', error);
  }
}
