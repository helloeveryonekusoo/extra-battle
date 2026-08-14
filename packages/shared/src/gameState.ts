/**
 * GameState の生成と参照ヘルパ。
 * ルール判定はしない。空の卓を用意することと、状態を読みやすく引くことだけを行う。
 */
import type {
  CardInstance,
  CardText,
  GameState,
  PlayerId,
  PlayerState,
  PokemonInPlay,
  SlotId,
  Zone,
} from './types';

export interface PlayerSeat {
  playerId: PlayerId;
  displayName: string;
}

export interface CreateGameOptions {
  gameId: string;
  rngSeed: string;
  /** 席順。turnQueue の初期値にもなる */
  seats: readonly PlayerSeat[];
  /** 既定のベンチ上限。スタジアム等で後から変わる（§5.1-1） */
  benchLimit?: number;
  /** 既定のサイド枚数。ハーフデッキ等で変わる（§5.1-2） */
  prizes?: number;
}

export function createPlayerState(
  seat: PlayerSeat,
  benchLimit: number,
  prizes: number,
): PlayerState {
  return {
    playerId: seat.playerId,
    displayName: seat.displayName,
    pokemon: [],
    benchLimit,
    prizesRemaining: prizes,
    prizesTotal: prizes,
    turnFlags: {
      energyAttached: false,
      supporterUsed: false,
      stadiumPlayed: false,
      retreated: false,
      attacksUsed: 0,
    },
    // 対戦中1回の枠（T36）。番が変わっても戻らないので、ここでだけ初期化する
    oncePerGameUsed: [],
  };
}

export function createGameState(options: CreateGameOptions): GameState {
  const { gameId, rngSeed, seats, benchLimit = 5, prizes = 6 } = options;
  // 席が0でも作れる。ルームは空の卓を用意してから参加者を迎える（T6）
  const first = seats[0];

  const players: Record<PlayerId, PlayerState> = {};
  for (const seat of seats) {
    players[seat.playerId] = createPlayerState(seat, benchLimit, prizes);
  }

  return {
    gameId,
    turn: 0,
    activePlayer: first?.playerId ?? '',
    phase: 'setup',
    players,
    cards: {},
    stadium: null,
    turnQueue: seats.map((s) => s.playerId),
    turnQueueMeta: seats.map(() => ({ isExtra: false, source: null })),
    firstPlayer: null,
    turnHistory: [],
    pokemonCheck: null,
    gameEnd: null,
    effects: [],
    abilityUses: {},
    execution: null,
    rngSeed,
    pendingUndo: null,
    setup: {
      step: 'janken',
      jankenWinner: null,
      firstPlayer: null,
      progress: Object.fromEntries(
        seats.map((s) => [s.playerId, { mulligans: 0, bonusDraw: null, ready: false }]),
      ),
    },
    log: [],
  };
}

/**
 * デッキのカード実体を作る。
 * 初期状態は山札なので誰にも見えない（visibleTo は空）。
 */
export function createDeckInstances(
  ownerId: PlayerId,
  cards: readonly CardText[],
  idPrefix: string,
): CardInstance[] {
  return cards.map((card, i) => ({
    instanceId: `${idPrefix}-${i}`,
    functionalId: card.functionalId,
    ownerId,
    zone: 'deck' as Zone,
    visibleTo: [],
    faceUp: false,
    position: i,
  }));
}

/** 状態にカード実体を流し込む（生成時のみ使う。以降は Action 経由） */
export function withCards(state: GameState, cards: readonly CardInstance[]): GameState {
  const next: GameState = { ...state, cards: { ...state.cards } };
  for (const card of cards) {
    next.cards[card.instanceId] = card;
  }
  return next;
}

/** そのプレイヤーの指定ゾーンのカードを position 順で返す。山札は index 0 が一番上 */
export function cardsInZone(
  state: GameState,
  ownerId: PlayerId,
  zone: Zone,
): CardInstance[] {
  return Object.values(state.cards)
    .filter((c) => c.ownerId === ownerId && c.zone === zone)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

export function findSlot(
  state: GameState,
  playerId: PlayerId,
  slotId: SlotId,
): PokemonInPlay | undefined {
  return state.players[playerId]?.pokemon.find((p) => p.slotId === slotId);
}

/** 空いている一番若いベンチスロット。上限に達していれば undefined */
export function nextFreeBenchSlot(state: GameState, playerId: PlayerId): SlotId | undefined {
  const player = state.players[playerId];
  if (!player) return undefined;
  const used = new Set(player.pokemon.map((p) => p.slotId));
  for (let i = 0; i < player.benchLimit; i += 1) {
    const slotId: SlotId = `bench-${i}`;
    if (!used.has(slotId)) return slotId;
  }
  return undefined;
}
