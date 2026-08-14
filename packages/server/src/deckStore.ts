/**
 * ディスク上のデッキリストを読む唯一の場所（第4段階 T43）。
 *
 * 形式はクライアントの書き出し・読み込みと同じ `pokeca-extra-deck`。
 * ★ここで持つのは functionalId と枚数だけ。カードの中身は data/cards/ 側にある。
 *
 * 絶対制約: 外部から取得しない。ローカルの JSON を読むだけ。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { SubmittedDeck } from '@pokeca/shared';

const here = dirname(fileURLToPath(import.meta.url));

/** リポジトリルートの data/decks/ */
export const DECK_DATA_DIR = resolve(here, '../../../data/decks');

export const DECK_FILE_FORMAT = 'pokeca-extra-deck';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseDeckFile(json: unknown, label: string): SubmittedDeck {
  if (!isRecord(json)) throw new Error(`${label}: デッキがオブジェクトではありません`);
  if (json['format'] !== DECK_FILE_FORMAT) {
    throw new Error(`${label}: format は "${DECK_FILE_FORMAT}" です`);
  }
  if (typeof json['name'] !== 'string' || json['name'] === '') {
    throw new Error(`${label}: name がありません`);
  }
  const raw = json['cards'];
  if (!Array.isArray(raw)) throw new Error(`${label}: cards は配列です`);

  // 同じ functionalId が複数行に分かれていてもまとめる
  const totals = new Map<string, number>();
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry['functionalId'] !== 'string') {
      throw new Error(`${label}: 各カードには functionalId が必要です`);
    }
    const count = Math.trunc(Number(entry['count']));
    if (!Number.isFinite(count) || count < 0) throw new Error(`${label}: 枚数は0以上の整数です`);
    if (count > 0) totals.set(entry['functionalId'], (totals.get(entry['functionalId']) ?? 0) + count);
  }
  return {
    name: json['name'],
    cards: [...totals].map(([functionalId, count]) => ({ functionalId, count })),
  };
}

export function loadDeck(fileName: string): SubmittedDeck {
  const path = resolve(DECK_DATA_DIR, fileName);
  return parseDeckFile(JSON.parse(readFileSync(path, 'utf8')) as unknown, fileName);
}

/** data/decks/ にあるデッキを全部読む。ないときは空 */
export function loadAllDecks(): SubmittedDeck[] {
  let files: string[];
  try {
    files = readdirSync(DECK_DATA_DIR).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return files.map((name) => loadDeck(name));
}
