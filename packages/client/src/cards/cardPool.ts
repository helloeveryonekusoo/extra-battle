/**
 * 実行時のカードプール（第5段階 T45）。
 *
 * ★カードデータをアプリに同梱しない。
 *   公開リポジトリに置くとカードテキストを配布することになるため
 *   （絶対制約2）、**使う人が自分の端末に読み込む**。
 *   読み込んだものはブラウザに残るので、次回からは何もしなくてよい。
 *
 * ★どこでこれを使うかは接続先で変わる（T48）。
 *   同じネットワークの対戦 … 卓の定義は **サーバーから届いたもの**。ここは使わない
 *   オンライン対戦        … ★ホストもゲストも **自分の端末のこれ** を使う
 *   卓の外の画面          … デッキ構築・カード見本はいつもこれ
 *
 * ★オンラインでカード定義を送り合わない理由は、送れば配布になるから（絶対制約2）。
 *   そのぶん、両者が同じデータを読み込んでいないとカードの見え方がずれる。
 */
import { buildCardIndex, parseCardTexts, type CardIndex, type CardText } from '@pokeca/shared';

export const CARD_POOL_KEY = 'pokeca-card-pool-v1';

/** 空のプール。読み込む前はこれ */
export const EMPTY_POOL: CardIndex = buildCardIndex([]);

export interface CardPoolInfo {
  index: CardIndex;
  /** 読み込んだファイル名。画面に出す */
  sources: string[];
  updatedAt: string | null;
}

interface StoredPool {
  version: 1;
  updatedAt: string;
  sources: string[];
  cards: CardText[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 保存してあるプールを読む。壊れていれば空を返す（読めないことでアプリを止めない） */
export function loadCardPool(): CardPoolInfo {
  try {
    const raw = window.localStorage.getItem(CARD_POOL_KEY);
    if (!raw) return { index: EMPTY_POOL, sources: [], updatedAt: null };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed['cards'])) {
      return { index: EMPTY_POOL, sources: [], updatedAt: null };
    }
    return {
      index: buildCardIndex(parseCardTexts(parsed['cards'])),
      sources: Array.isArray(parsed['sources']) ? (parsed['sources'] as string[]) : [],
      updatedAt: typeof parsed['updatedAt'] === 'string' ? parsed['updatedAt'] : null,
    };
  } catch {
    return { index: EMPTY_POOL, sources: [], updatedAt: null };
  }
}

/**
 * 読み込んだカードを保存する。
 * ★同じ functionalId は後から来たもので上書きする（差し替えができるように）。
 */
export function saveCardPool(
  files: readonly { name: string; cards: readonly CardText[] }[],
  previous: CardPoolInfo = loadCardPool(),
): CardPoolInfo {
  const merged = new Map<string, CardText>();
  for (const card of previous.index.all) merged.set(card.functionalId, card);
  for (const file of files) {
    for (const card of file.cards) merged.set(card.functionalId, card);
  }

  const sources = [...new Set([...previous.sources, ...files.map((f) => f.name)])];
  const stored: StoredPool = {
    version: 1,
    updatedAt: new Date().toISOString(),
    sources,
    cards: [...merged.values()],
  };
  window.localStorage.setItem(CARD_POOL_KEY, JSON.stringify(stored));
  return { index: buildCardIndex(stored.cards), sources, updatedAt: stored.updatedAt };
}

export function clearCardPool(): CardPoolInfo {
  window.localStorage.removeItem(CARD_POOL_KEY);
  return { index: EMPTY_POOL, sources: [], updatedAt: null };
}

/**
 * JSON文字列をカードとして読む。
 * ★検証は共有の parseCardTexts に任せる。壊れたデータは例外で弾く（黙って通さない）。
 */
export function readCardFile(name: string, json: string): { name: string; cards: CardText[] } {
  return { name, cards: parseCardTexts(JSON.parse(json)) };
}
