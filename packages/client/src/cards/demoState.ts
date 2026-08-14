/**
 * 盤面デモ用のサンプル状態（T8 の完了条件）。
 *
 * 手で GameState を書かず、**本物の applyAction を通して**組み立てる。
 * こうしておくと、盤面が描けたことが「アクション経路が正しく動くこと」の確認にもなる。
 * 最後に filterStateFor を通すので、相手の手札は実際の対戦と同じく見えない。
 */
import {
  applyActions,
  createGameState,
  filterStateFor,
  type Action,
  type Actor,
  type GameState,
  type PlayerId,
  type UnstampedAction,
} from '@pokeca/shared';
import { sampleCardIndex } from './sampleCards';

export const DEMO_ME: PlayerId = 'p-1';
export const DEMO_OPPONENT: PlayerId = 'p-2';

/** 自分の山札の並び。index がそのまま instanceId の番号になる */
const MY_DECK = [
  // 0-6 手札に来る7枚
  'サーチボール',
  '研究員の指示',
  '基本水エネルギー',
  'カメール',
  'フルリペア',
  '交代の号令',
  '基本水エネルギー',
  // 7-9 バトル場の進化ライン
  'ゼニガメ',
  'カメール',
  'カメックス',
  // 10-12 ついているもの
  '基本水エネルギー',
  '基本水エネルギー',
  'スピードふうせん',
  // 13-15 ベンチ
  'ピカチュウ',
  'ヤミカラス',
  'コイル',
  // 16 スタジアム
  '拡張フィールド',
];

const OPPONENT_DECK = [
  // 0-2 バトル場の進化ライン
  'ヒトカゲ',
  'リザード',
  'リザードンex',
  // 3-4 エネルギー
  '基本炎エネルギー',
  '基本炎エネルギー',
  // 5-6 ベンチ
  'ロコン',
  'ミニリュウ',
  // 7 どうぐ
  'がんじょうベルト',
];

const FILLER = '基本草エネルギー';
/** 場・手札・サイド・トラッシュに配ったあと、山札が実戦らしい枚数で残るようにする */
const DECK_SIZE = 45;

function functionalIdOf(name: string): string | undefined {
  return sampleCardIndex.byName.get(name)?.[0]?.functionalId;
}

function deckCards(names: readonly string[], prefix: string) {
  const filler = functionalIdOf(FILLER);
  const cards: { instanceId: string; functionalId: string }[] = [];
  for (let i = 0; i < DECK_SIZE; i += 1) {
    const functionalId = (names[i] ? functionalIdOf(names[i]!) : undefined) ?? filler;
    if (!functionalId) return null;
    cards.push({ instanceId: `${prefix}-${i}`, functionalId });
  }
  return cards;
}

/** サンプルカードが読めない環境では null を返す */
export function buildDemoState(): GameState | null {
  const mine = deckCards(MY_DECK, 'm');
  const theirs = deckCards(OPPONENT_DECK, 'o');
  if (!mine || !theirs) return null;

  let at = 1_800_000_000_000;
  const act = (a: UnstampedAction, actorId: Actor = DEMO_ME): Action =>
    ({ ...a, actorId, at: (at += 1000) }) as Action;

  const base = createGameState({
    gameId: 'g-demo',
    rngSeed: 'demo',
    seats: [
      { playerId: DEMO_ME, displayName: 'あなた' },
      { playerId: DEMO_OPPONENT, displayName: 'ともだち' },
    ],
  });

  const actions: Action[] = [
    // 対戦準備は済んだものとして始める
    act({ type: 'setSetupStep', step: 'done' }, 'server'),
    act({ type: 'setupDeck', playerId: DEMO_ME, cards: mine }, 'server'),
    act({ type: 'setupDeck', playerId: DEMO_OPPONENT, cards: theirs }, 'server'),
    act({ type: 'setPhase', phase: 'turn' }, 'server'),

    // ── 自分の場 ──
    act({ type: 'placePokemon', playerId: DEMO_ME, slotId: 'active', cardId: 'm-7' }),
    act({ type: 'evolvePokemon', playerId: DEMO_ME, slotId: 'active', cardId: 'm-8' }),
    act({ type: 'evolvePokemon', playerId: DEMO_ME, slotId: 'active', cardId: 'm-9' }),
    act({ type: 'attachCard', playerId: DEMO_ME, slotId: 'active', cardId: 'm-10', as: 'energy' }),
    act({ type: 'attachCard', playerId: DEMO_ME, slotId: 'active', cardId: 'm-11', as: 'energy' }),
    act({ type: 'attachCard', playerId: DEMO_ME, slotId: 'active', cardId: 'm-12', as: 'tool' }),
    act({ type: 'adjustDamage', playerId: DEMO_ME, slotId: 'active', delta: 7 }),
    act({
      type: 'setCondition',
      playerId: DEMO_ME,
      slotId: 'active',
      condition: 'poisoned',
      on: true,
    }),
    act({ type: 'placePokemon', playerId: DEMO_ME, slotId: 'bench-0', cardId: 'm-13' }),
    act({ type: 'placePokemon', playerId: DEMO_ME, slotId: 'bench-1', cardId: 'm-14' }),
    act({ type: 'placePokemon', playerId: DEMO_ME, slotId: 'bench-2', cardId: 'm-15' }),
    act({ type: 'adjustDamage', playerId: DEMO_ME, slotId: 'bench-1', delta: 4 }),
    act({
      type: 'setCondition',
      playerId: DEMO_ME,
      slotId: 'bench-1',
      condition: 'asleep',
      on: true,
    }),

    // ── 相手の場 ──
    act({ type: 'placePokemon', playerId: DEMO_OPPONENT, slotId: 'active', cardId: 'o-0' }, DEMO_OPPONENT),
    act({ type: 'evolvePokemon', playerId: DEMO_OPPONENT, slotId: 'active', cardId: 'o-1' }, DEMO_OPPONENT),
    act({ type: 'evolvePokemon', playerId: DEMO_OPPONENT, slotId: 'active', cardId: 'o-2' }, DEMO_OPPONENT),
    act({ type: 'attachCard', playerId: DEMO_OPPONENT, slotId: 'active', cardId: 'o-3', as: 'energy' }, DEMO_OPPONENT),
    act({ type: 'attachCard', playerId: DEMO_OPPONENT, slotId: 'active', cardId: 'o-4', as: 'energy' }, DEMO_OPPONENT),
    act({ type: 'attachCard', playerId: DEMO_OPPONENT, slotId: 'active', cardId: 'o-7', as: 'tool' }, DEMO_OPPONENT),
    act({ type: 'adjustDamage', playerId: DEMO_OPPONENT, slotId: 'active', delta: 12 }, DEMO_OPPONENT),
    act({ type: 'setCondition', playerId: DEMO_OPPONENT, slotId: 'active', condition: 'confused', on: true }, DEMO_OPPONENT),
    act({ type: 'placePokemon', playerId: DEMO_OPPONENT, slotId: 'bench-0', cardId: 'o-5' }, DEMO_OPPONENT),
    act({ type: 'placePokemon', playerId: DEMO_OPPONENT, slotId: 'bench-1', cardId: 'o-6' }, DEMO_OPPONENT),
    // 対戦準備でウラのまま出した1匹（可視性がゾーン固定でないことの確認）
    act({ type: 'placePokemon', playerId: DEMO_OPPONENT, slotId: 'bench-2', cardId: 'o-8', faceUp: false }, DEMO_OPPONENT),

    // ── サイド ──
    ...['m-20', 'm-21', 'm-22', 'm-23', 'm-24', 'm-25'].map((cardId) =>
      act({ type: 'moveCard', cardId, toZone: 'prize' as const }, 'server'),
    ),
    ...['o-20', 'o-21', 'o-22', 'o-23', 'o-24', 'o-25'].map((cardId) =>
      act({ type: 'moveCard', cardId, toZone: 'prize' as const }, 'server'),
    ),
    act({ type: 'setPrizes', playerId: DEMO_ME, prizesRemaining: 4 }, 'server'),
    act({ type: 'setPrizes', playerId: DEMO_OPPONENT, prizesRemaining: 5 }, 'server'),

    // ── スタジアム。ベンチ上限が可変であることを見せる ──
    act({ type: 'moveCard', cardId: 'm-16', toZone: 'stadium' }),
    act({ type: 'setStadium', cardId: 'm-16' }),
    act({ type: 'setBenchLimit', playerId: DEMO_ME, benchLimit: 8 }),
    act({ type: 'setBenchLimit', playerId: DEMO_OPPONENT, benchLimit: 8 }),

    // ── トラッシュとロスト ──
    act({ type: 'moveCard', cardId: 'm-26', toZone: 'discard' }),
    act({ type: 'moveCard', cardId: 'm-27', toZone: 'discard' }),
    act({ type: 'moveCard', cardId: 'o-26', toZone: 'lost' }, DEMO_OPPONENT),

    // ── 手札 ──
    act(
      { type: 'drawCards', playerId: DEMO_ME, cardIds: ['m-0', 'm-1', 'm-2', 'm-3', 'm-4', 'm-5', 'm-6'] },
      DEMO_ME,
    ),
    act(
      { type: 'drawCards', playerId: DEMO_OPPONENT, cardIds: ['o-9', 'o-10', 'o-11', 'o-12', 'o-13'] },
      DEMO_OPPONENT,
    ),

    // ── 手番 ──
    act({ type: 'setTurnFlag', playerId: DEMO_ME, flag: 'energyAttached', value: true }),
    act({ type: 'setTurnFlag', playerId: DEMO_ME, flag: 'supporterUsed', value: true }),
    act({ type: 'setActivePlayer', playerId: DEMO_ME }, 'server'),
    act({ type: 'note', text: 'デモ用のサンプル状態です' }, 'server'),
  ];

  // 実際の対戦と同じく、自分に見えてよい情報だけに絞る
  return filterStateFor(applyActions(base, actions), DEMO_ME);
}
