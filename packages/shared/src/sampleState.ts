import type {
  CardInstance,
  GameState,
  PlayerId,
  PlayerState,
  PokemonInPlay,
} from './types';

/**
 * §5 の型が実際に組み上がることを示すサンプル GameState（T2 の完了条件）。
 *
 * わざと以下の「型を固定してはいけない箇所」を踏んでいる:
 * - benchLimit が 8（スカイフィールド適用中）と 5 で左右非対称
 * - prizesRemaining / prizesTotal が 6 以外
 * - turnQueue に同じプレイヤーが連続（追加ターン）
 * - バトル場のカードが faceUp: false（対戦準備でウラのまま出した状態）
 * - 同じ手札カードが一時的に相手にも見えている（マリガン公開）
 */

const ALICE: PlayerId = 'p-alice';
const BOB: PlayerId = 'p-bob';

const card = (
  instanceId: string,
  functionalId: string,
  ownerId: PlayerId,
  zone: CardInstance['zone'],
  visibleTo: PlayerId[],
  faceUp: boolean,
  position?: number,
): CardInstance => ({ instanceId, functionalId, ownerId, zone, visibleTo, faceUp, position });

const emptyPokemon = (slotId: PokemonInPlay['slotId'], stack: string[]): PokemonInPlay => ({
  slotId,
  stack,
  attachedEnergy: [],
  attachedTool: null,
  damageCounters: 0,
  conditions: [],
  placedOnTurn: 0,
  evolvedOnTurn: null,
  devolvedOnTurn: null,
  grantedAttacks: [],
  notes: '',
});

const alice: PlayerState = {
  playerId: ALICE,
  displayName: 'アリス',
  oncePerGameUsed: [],
  pokemon: [
    {
      ...emptyPokemon('active', ['c-a-active']),
      attachedEnergy: ['c-a-energy'],
      damageCounters: 5,
      conditions: ['poisoned'],
      grantedAttacks: [
        // ゾロアークの「イカサマ」が相手バトル場のワザを参照している状態
        { functionalId: 'fn-slowbro', attackIndex: 0, sourceInstanceId: 'c-b-active' },
      ],
      notes: 'イカサマ参照中',
    },
    { ...emptyPokemon('bench-0', ['c-a-bench0']), placedOnTurn: 3 },
  ],
  // スカイフィールド適用中
  benchLimit: 8,
  prizesRemaining: 4,
  prizesTotal: 6,
  turnFlags: {
    energyAttached: true,
    supporterUsed: false,
    stadiumPlayed: true,
    retreated: false,
    attacksUsed: 0,
  },
};

const bob: PlayerState = {
  playerId: BOB,
  displayName: 'ボブ',
  oncePerGameUsed: [],
  pokemon: [{ ...emptyPokemon('active', ['c-b-active']), damageCounters: 0 }],
  benchLimit: 5,
  // ハーフデッキ等でサイドが6でないケース
  prizesRemaining: 3,
  prizesTotal: 3,
  turnFlags: {
    energyAttached: false,
    supporterUsed: false,
    stadiumPlayed: false,
    retreated: false,
    attacksUsed: 0,
  },
};

export const sampleGameState: GameState = {
  gameId: 'g-sample',
  turn: 4,
  activePlayer: ALICE,
  phase: 'turn',
  players: { [ALICE]: alice, [BOB]: bob },
  cards: {
    // バトル場だが対戦準備でウラのまま出したので誰にも見えていない
    'c-a-active': card('c-a-active', 'fn-slowbro', ALICE, 'active', [], false),
    'c-a-bench0': card('c-a-bench0', 'fn-psyduck', ALICE, 'bench', [ALICE, BOB], true),
    'c-a-energy': card('c-a-energy', 'fn-water-energy', ALICE, 'active', [ALICE, BOB], true),
    // 自分だけが見られる手札
    'c-a-hand0': card('c-a-hand0', 'fn-professors-research', ALICE, 'hand', [ALICE], false, 0),
    // マリガンで相手にも公開した手札
    'c-a-hand1': card('c-a-hand1', 'fn-psyduck', ALICE, 'hand', [ALICE, BOB], false, 1),
    // 山札は誰にも見えない
    'c-a-deck0': card('c-a-deck0', 'fn-water-energy', ALICE, 'deck', [], false, 0),
    // サイドをオモテにする効果を受けた1枚
    'c-a-prize0': card('c-a-prize0', 'fn-boss-orders', ALICE, 'prize', [ALICE, BOB], true, 0),
    // ロストゾーンは両者常時公開
    'c-a-lost0': card('c-a-lost0', 'fn-psyduck', ALICE, 'lost', [ALICE, BOB], true),

    'c-b-active': card('c-b-active', 'fn-snorlax', BOB, 'active', [ALICE, BOB], true),
    'c-b-hand0': card('c-b-hand0', 'fn-boss-orders', BOB, 'hand', [BOB], false, 0),

    'c-stadium': card('c-stadium', 'fn-sky-field', ALICE, 'stadium', [ALICE, BOB], true),
  },
  stadium: 'c-stadium',
  // 追加ターン（スタークロノス等）が挿入され、アリスが連続で番を取る
  turnQueue: [ALICE, ALICE, BOB],
  turnQueueMeta: [
    { isExtra: false, source: null },
    { isExtra: true, source: 'スタークロノス' },
    { isExtra: false, source: null },
  ],
  firstPlayer: ALICE,
  turnHistory: [
    { turn: 1, playerId: ALICE, isExtra: false },
    { turn: 2, playerId: BOB, isExtra: false },
    { turn: 3, playerId: ALICE, isExtra: false },
    { turn: 4, playerId: ALICE, isExtra: true, source: 'スタークロノス' },
  ],
  pokemonCheck: null,
  gameEnd: null,
  effects: [],
  abilityUses: {},
  execution: null,
  rngSeed: 'sample-seed-0001',
  pendingUndo: null,
  // 対戦中なので準備は終わっている
  setup: null,
  log: [
    {
      seq: 1,
      at: 1_760_000_000_000,
      actorId: 'server',
      action: {
        type: 'shuffleDeck',
        actorId: 'server',
        at: 1_760_000_000_000,
        seed: 'sample-seed-0001:1',
        playerId: ALICE,
        order: ['c-a-deck0'],
      },
      summary: 'アリスの山札をシャッフルした',
      visibleTo: [ALICE, BOB],
      seed: 'sample-seed-0001:1',
      undone: false,
      warnings: [],
    },
    {
      seq: 2,
      at: 1_760_000_001_000,
      actorId: ALICE,
      action: {
        type: 'attachCard',
        actorId: ALICE,
        at: 1_760_000_001_000,
        playerId: ALICE,
        slotId: 'active',
        cardId: 'c-a-energy',
        as: 'energy',
      },
      summary: 'アリスがバトル場に水エネルギーをつけた',
      visibleTo: [ALICE, BOB],
      undone: false,
      warnings: [],
    },
  ],
};
