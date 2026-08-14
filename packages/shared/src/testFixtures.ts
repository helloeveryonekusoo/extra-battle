/**
 * テスト用の卓。プロダクションコードからは使わない。
 */
import { createGameState, withCards } from './gameState';
import type { CardInstance, GameState, PlayerId } from './types';

export const ALICE: PlayerId = 'p-alice';
export const BOB: PlayerId = 'p-bob';

let clock = 1_800_000_000_000;
/** Action の打刻。テストでは単調増加する固定値を使う */
export const tick = (): number => (clock += 1000);

export interface FixtureOptions {
  /** 各プレイヤーの山札枚数 */
  deckSize?: number;
}

/**
 * 山札だけが積まれた2人卓を作る。
 * カードIDは `a-deck-0` / `b-deck-0` ... の形。
 */
export function makeTable(options: FixtureOptions = {}): GameState {
  const { deckSize = 10 } = options;
  const base = createGameState({
    gameId: 'g-test',
    rngSeed: 'seed-test',
    seats: [
      { playerId: ALICE, displayName: 'アリス' },
      { playerId: BOB, displayName: 'ボブ' },
    ],
  });

  const cards: CardInstance[] = [];
  for (const [prefix, owner] of [
    ['a', ALICE],
    ['b', BOB],
  ] as const) {
    for (let i = 0; i < deckSize; i += 1) {
      cards.push({
        instanceId: `${prefix}-deck-${i}`,
        functionalId: `smpl-card-${i}`,
        ownerId: owner,
        zone: 'deck',
        visibleTo: [],
        faceUp: false,
        position: i,
      });
    }
  }

  return withCards({ ...base, phase: 'turn', turn: 1 }, cards);
}
