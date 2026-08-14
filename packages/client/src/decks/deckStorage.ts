import type { SubmittedDeck } from '@pokeca/shared';

export const DECK_STORAGE_KEY = 'pokeca-saved-decks-v1';
export const SELECTED_DECK_KEY = 'pokeca-selected-deck-v1';
export const DECK_FILE_FORMAT = 'pokeca-extra-deck';

export interface SavedDeck extends SubmittedDeck {
  id: string;
  updatedAt: string;
}

interface DeckFile {
  format: typeof DECK_FILE_FORMAT;
  version: 1;
  name: string;
  cards: { functionalId: string; count: number }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function normalizeCards(value: unknown): { functionalId: string; count: number }[] {
  if (!Array.isArray(value)) throw new Error('cards は配列で指定してください');
  const totals = new Map<string, number>();
  for (const item of value) {
    if (!isRecord(item) || typeof item['functionalId'] !== 'string') {
      throw new Error('各カードには functionalId が必要です');
    }
    const count = Math.trunc(Number(item['count']));
    if (!Number.isFinite(count) || count < 0) throw new Error('枚数は0以上の整数です');
    if (count > 0) totals.set(item['functionalId'], (totals.get(item['functionalId']) ?? 0) + count);
  }
  return [...totals].map(([functionalId, count]) => ({ functionalId, count }));
}

export function listSavedDecks(): SavedDeck[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(DECK_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value): SavedDeck[] => {
      if (
        !isRecord(value) ||
        typeof value['id'] !== 'string' ||
        typeof value['name'] !== 'string' ||
        typeof value['updatedAt'] !== 'string'
      ) {
        return [];
      }
      try {
        return [{
          id: value['id'],
          name: value['name'],
          updatedAt: value['updatedAt'],
          cards: normalizeCards(value['cards']),
        }];
      } catch {
        return [];
      }
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

function writeDecks(decks: readonly SavedDeck[]): void {
  window.localStorage.setItem(DECK_STORAGE_KEY, JSON.stringify(decks));
}

export function saveDeck(deck: Omit<SavedDeck, 'id' | 'updatedAt'>, id?: string): SavedDeck {
  const decks = listSavedDecks();
  const saved: SavedDeck = {
    ...deck,
    cards: normalizeCards(deck.cards),
    id: id ?? `deck-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    updatedAt: new Date().toISOString(),
  };
  const next = [saved, ...decks.filter((item) => item.id !== saved.id)];
  writeDecks(next);
  return saved;
}

export function deleteDeck(id: string): void {
  writeDecks(listSavedDecks().filter((deck) => deck.id !== id));
  if (window.localStorage.getItem(SELECTED_DECK_KEY) === id) window.localStorage.removeItem(SELECTED_DECK_KEY);
}

export function getSelectedDeckId(): string {
  try {
    return window.localStorage.getItem(SELECTED_DECK_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setSelectedDeckId(id: string): void {
  if (id) window.localStorage.setItem(SELECTED_DECK_KEY, id);
  else window.localStorage.removeItem(SELECTED_DECK_KEY);
}

export function serializeDeck(deck: Pick<SavedDeck, 'name' | 'cards'>): string {
  const file: DeckFile = {
    format: DECK_FILE_FORMAT,
    version: 1,
    name: deck.name,
    cards: normalizeCards(deck.cards),
  };
  return JSON.stringify(file, null, 2);
}

export function parseDeckFile(json: string): SubmittedDeck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('JSONを読み取れませんでした');
  }
  if (!isRecord(parsed) || parsed['format'] !== DECK_FILE_FORMAT || parsed['version'] !== 1) {
    throw new Error('ポケカ エクストラ用のデッキJSONではありません');
  }
  if (typeof parsed['name'] !== 'string' || parsed['name'].trim() === '') {
    throw new Error('デッキ名がありません');
  }
  return { name: parsed['name'].trim(), cards: normalizeCards(parsed['cards']) };
}
