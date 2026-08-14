/**
 * デッキの置き場（第5段階 T47）。
 *
 * ★置き場は2つ。どちらを使うかは「ログインしているか」だけで決まる。
 *
 *     ログイン中   … Firestore（users/{uid}/decks）。どの端末からでも同じデッキが出る
 *     ログアウト中 … この端末の localStorage（第2段階からのしくみ）
 *
 * ★画面はこのファイルだけを見る。呼び分けをここに閉じ込めておかないと、
 *   画面のあちこちに `if (ログイン中)` が散らばる。
 *
 * ★Firestore が落ちていてもアプリは止めない。
 *   読めなければローカルのぶんを返し、書けなければ理由を返す。
 */
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  setDoc,
  type Firestore,
} from 'firebase/firestore';
import { firestore } from '../auth/firebase';
import {
  deleteDeck as deleteLocalDeck,
  listSavedDecks as listLocalDecks,
  saveDeck as saveLocalDeck,
  type SavedDeck,
} from './deckStorage';

export type { SavedDeck };

/** ★Firestore のルールと同じ上限。書く前にこちらでも止める（無駄な失敗を減らす） */
export const MAX_DECK_NAME = 60;
export const MAX_DECK_LINES = 120;

export interface DeckLibrary {
  /** 'cloud' ならアカウント、'local' ならこの端末 */
  where: 'cloud' | 'local';
  decks: SavedDeck[];
  /** 読めなかったときの理由。null なら成功 */
  error: string | null;
}

const decksRef = (db: Firestore, uid: string) => collection(db, 'users', uid, 'decks');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Firestore の1件を SavedDeck に直す。壊れている行は捨てる */
function toSavedDeck(id: string, data: unknown): SavedDeck | null {
  if (!isRecord(data) || typeof data['name'] !== 'string') return null;
  const raw = data['cards'];
  if (!Array.isArray(raw)) return null;
  const cards = raw.flatMap((line) => {
    if (!isRecord(line) || typeof line['functionalId'] !== 'string') return [];
    const count = Math.trunc(Number(line['count']));
    return Number.isFinite(count) && count > 0 ? [{ functionalId: line['functionalId'], count }] : [];
  });
  return {
    id,
    name: data['name'],
    cards,
    updatedAt: typeof data['updatedAt'] === 'string' ? data['updatedAt'] : new Date(0).toISOString(),
  };
}

/** 保存する前の検査。★ルールで弾かれる前に、理由の分かる形で止める */
export function checkDeck(deck: Pick<SavedDeck, 'name' | 'cards'>): string | null {
  const name = deck.name.trim();
  if (name.length === 0) return 'デッキ名を入れてください';
  if (name.length > MAX_DECK_NAME) return `デッキ名は${MAX_DECK_NAME}文字までです`;
  if (deck.cards.length > MAX_DECK_LINES) return `カードの種類が多すぎます（${MAX_DECK_LINES}種類まで）`;
  return null;
}

// ── 読む ────────────────────────────

export async function loadLibrary(uid: string | null): Promise<DeckLibrary> {
  if (!uid) return { where: 'local', decks: listLocalDecks(), error: null };
  const db = firestore();
  if (!db) return { where: 'local', decks: listLocalDecks(), error: null };

  try {
    const snapshot = await getDocs(decksRef(db, uid));
    const decks = snapshot.docs
      .map((entry) => toSavedDeck(entry.id, entry.data()))
      .filter((deck): deck is SavedDeck => deck !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { where: 'cloud', decks, error: null };
  } catch {
    // ★読めなくても画面は出す。ローカルのぶんで続けられるようにする
    return { where: 'local', decks: listLocalDecks(), error: 'アカウントのデッキを読めませんでした' };
  }
}

// ── 書く ────────────────────────────

const newId = (): string => `deck-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export async function saveDeckTo(
  uid: string | null,
  deck: Pick<SavedDeck, 'name' | 'cards'>,
  id?: string,
): Promise<SavedDeck> {
  const problem = checkDeck(deck);
  if (problem) throw new Error(problem);

  if (!uid) return saveLocalDeck(deck, id);
  const db = firestore();
  if (!db) return saveLocalDeck(deck, id);

  const saved: SavedDeck = {
    id: id ?? newId(),
    name: deck.name.trim(),
    cards: deck.cards,
    updatedAt: new Date().toISOString(),
  };
  await setDoc(doc(decksRef(db, uid), saved.id), {
    name: saved.name,
    cards: saved.cards,
    updatedAt: saved.updatedAt,
  });
  return saved;
}

export async function deleteDeckFrom(uid: string | null, id: string): Promise<void> {
  if (!uid) {
    deleteLocalDeck(id);
    return;
  }
  const db = firestore();
  if (!db) {
    deleteLocalDeck(id);
    return;
  }
  await deleteDoc(doc(decksRef(db, uid), id));
}

/**
 * ★ログインしたときに、この端末のデッキをアカウントへ引き上げる。
 *   同じ名前があれば増やさない（何度ログインしても増殖しないように）。
 *   引き上げたあともローカルは消さない（ログアウトしても手元に残る）。
 */
export async function uploadLocalDecks(uid: string, existing: readonly SavedDeck[]): Promise<number> {
  const known = new Set(existing.map((deck) => deck.name));
  const targets = listLocalDecks().filter((deck) => !known.has(deck.name));
  for (const deck of targets) {
    if (checkDeck(deck)) continue;
    await saveDeckTo(uid, { name: deck.name, cards: deck.cards }, deck.id);
  }
  return targets.length;
}
