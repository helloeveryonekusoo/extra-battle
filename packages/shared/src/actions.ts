/**
 * 原子操作（Action）の定義と適用（T4）。
 *
 * ★このファイルはルールを一切判定しない。
 *   「たねポケモンしか場に出せない」「エネルギーは1ターン1枚」といった判断は人間が行う。
 *   applyAction は言われたとおりに盤面を書き換えるだけ。
 *
 * ★純粋関数。入力の GameState を壊さない。
 *   状態は数KB なので structuredClone で丸ごと複製してから書き換える（§4.1）。
 *
 * ★乱数は持たない。シャッフル結果もコインの裏表も、
 *   サーバーが決めた結果を Action に載せて渡す（§4.2）。これで対戦を再現できる。
 *
 * ただし以下の「整合性の後始末」は行う。これはルール判定ではなく参照の掃除:
 *   - カードが場から離れたら、ついていたエネルギー/どうぐ/進化スタックの参照を外す
 *   - 進化スタックが空になったらそのスロットを消す
 *   - スタジアムのカードが場を離れたら stadium を null にする
 *   - ゾーン内の position を 0 から振り直す
 */
import {
  cardOf,
  checkAction,
  multipleLockNotice,
  turnFlagUpdates,
  type ActionResult,
  type RuleContext,
  type RuleWarning,
} from './rules';
import { createPokemonCheckState } from './pokemonCheck';
import {
  clearConditionsOffActive,
  effectSlotKey,
  expireByDuration,
  expireOnEvent,
  sweepEffects,
} from './effects';
import {
  createExecution,
  resolveChoiceInPlace,
  restoreTemporaryReveal,
  stepEffectInPlace,
  type EffectRolls,
} from './interpreter';
import { abilityOf, abilityUseKey } from './derived';
import { discardZoneFor, markOncePerGameUsed, ONCE_PER_GAME_LABEL } from './ruleBox';
import type { EffectSource, Op } from './dsl';
import { createGameEndProposal, detectDefeat } from './defeat';
// 盤面をさわる道具は board.ts が唯一の出どころ。効果インタプリタも同じものを使う（T24）
import {
  ActionError,
  defaultVisibilityFor,
  getCard,
  getPlayer,
  getSlot,
  playerIdsOf,
  relocate,
  syncSlotZones,
  zoneForSlot,
  type InsertAt,
} from './board';
import type {
  Actor,
  Attack,
  AttackRef,
  GameState,
  LogEntry,
  OncePerGameKind,
  PlayerId,
  PokemonInPlay,
  SetupProgress,
  SetupStep,
  SlotId,
  TurnRecord,
  SpecialCondition,
  BooleanTurnFlag,
  Zone,
} from './types';

// ── 共通 ─────────────────────────────

export { ActionError, defaultVisibilityFor, type InsertAt };

export interface ActionBase {
  type: string;
  /** 誰の操作か。シャッフル・コインなどサーバー由来の操作は 'server' */
  actorId: Actor;
  /** epoch ミリ秒。applyAction を純粋に保つため、サーバーが打刻して載せる */
  at: number;
  /** 乱数を使った操作の再現用シード（§4.2） */
  seed?: string;
  /** ログの要約を読んでよいプレイヤー。省略時は全員 */
  logVisibleTo?: PlayerId[];
}


// ── 席 ───────────────────────────────

/**
 * 卓に参加する。
 * ★参加もアクションにしておくことで、卓の状態が「初期状態 + アクション列」から
 *   完全に再現できるようになる。Undo（T11）と対戦の再現（§4.2）の土台。
 */
export interface AddPlayerAction extends ActionBase {
  type: 'addPlayer';
  playerId: PlayerId;
  displayName: string;
  benchLimit?: number;
  prizes?: number;
}

// ── 取り消し（T11） ────────────────────

/** この seq 以降の操作を取り消したい、という要求。相手が承認するまで何も起きない */
export interface RequestUndoAction extends ActionBase {
  type: 'requestUndo';
  targetSeq: number;
}

/** 要求への返事。承認された場合の巻き戻し自体はサーバーが行う */
export interface ResolveUndoAction extends ActionBase {
  type: 'resolveUndo';
  requestId: string;
  approved: boolean;
  targetSeq?: number;
}

// ── 卓の準備 ─────────────────────────

/**
 * そのプレイヤーのカードをすべて捨てて、渡された順で山札を積み直す。
 * デッキを卓に置く操作そのもの。並びはサーバーが決める（§4.2）。
 */
export interface SetupDeckAction extends ActionBase {
  type: 'setupDeck';
  playerId: PlayerId;
  /** 山札の上から順。instanceId はサーバーが採番する */
  cards: { instanceId: string; functionalId: string }[];
}

// ── カードの移動と可視性 ──────────────────

export interface MoveCardAction extends ActionBase {
  type: 'moveCard';
  cardId: string;
  toZone: Zone;
  /** 省略時は末尾（山札なら一番下）。ActionBase.at（打刻）とは別物 */
  insertAt?: InsertAt;
  /** 省略時は移動先ゾーンの既定に従う */
  faceUp?: boolean;
  /** 省略時は移動先ゾーンの既定に従う */
  visibleTo?: PlayerId[];
}

export interface ShuffleDeckAction extends ActionBase {
  type: 'shuffleDeck';
  playerId: PlayerId;
  /** サーバーが決めた新しい並び。index 0 が山札の一番上 */
  order: string[];
  /** 「山札を見る」効果で公開していたカードを伏せ直す。既定 true */
  conceal?: boolean;
}

export interface ShuffleIntoDeckAction extends ActionBase {
  type: 'shuffleIntoDeck';
  playerId: PlayerId;
  /** 山札に加えるカード */
  cardIds: string[];
  /** 加えたあとの山札全体の並び。サーバーが決める */
  order: string[];
}

export interface DrawCardsAction extends ActionBase {
  type: 'drawCards';
  playerId: PlayerId;
  /** サーバーが山札の上から取ったカード。順序は引いた順 */
  cardIds: string[];
}

export interface SetFaceUpAction extends ActionBase {
  type: 'setFaceUp';
  cardId: string;
  faceUp: boolean;
}

/** 「相手に公開」「公開をやめる」。可視性はカード単位で持つ（§4.3） */
export interface SetCardVisibilityAction extends ActionBase {
  type: 'setCardVisibility';
  cardIds: string[];
  visibleTo: PlayerId[];
}

// ── 場のポケモン ──────────────────────

export interface PlacePokemonAction extends ActionBase {
  type: 'placePokemon';
  playerId: PlayerId;
  slotId: SlotId;
  cardId: string;
  /** 対戦準備ではウラのまま置く。既定 true */
  faceUp?: boolean;
}

/**
 * V-UNION を組み立ててベンチに出す（第4段階 T38）。
 *
 * ★4枚を1つのスタックに積む。進化ではないので evolvedOnTurn は立てない。
 * ★「対戦中1回」はプレイヤー単位（T36 と同じ枠組み）。ここで消費する。
 */
export interface AssembleVUnionAction extends ActionBase {
  type: 'assembleVUnion';
  playerId: PlayerId;
  slotId: SlotId;
  /** 1枚目から4枚目の順に並べた instanceId */
  cardIds: string[];
}

export interface EvolvePokemonAction extends ActionBase {
  type: 'evolvePokemon';
  playerId: PlayerId;
  slotId: SlotId;
  cardId: string;
}

export interface DevolvePokemonAction extends ActionBase {
  type: 'devolvePokemon';
  playerId: PlayerId;
  slotId: SlotId;
  /** 剥がした一番上のカードの行き先 */
  toZone: Zone;
}

export interface AttachCardAction extends ActionBase {
  type: 'attachCard';
  playerId: PlayerId;
  slotId: SlotId;
  cardId: string;
  /** どうぐ枠は1匹1枚。クレッフィのようにポケモンをどうぐとしてつける場合も 'tool' */
  as: 'energy' | 'tool';
  /**
   * ★いつ外れるか（第4段階 T40）。
   *   クレッフィ（ワンダーロック）のように「相手の番の終わりにトラッシュする」カード用。
   *   指定すると `temporaryTool` の効果が立ち、期間が切れた時点でカードごと落ちる。
   */
  until?: 'endOfNextOpponentTurn';
}

export interface DetachCardAction extends ActionBase {
  type: 'detachCard';
  playerId: PlayerId;
  slotId: SlotId;
  cardId: string;
  toZone: Zone;
}

/** バトル場↔ベンチ。移動先が埋まっていれば入れ替え、空なら移動 */
export interface MovePokemonAction extends ActionBase {
  type: 'movePokemon';
  playerId: PlayerId;
  fromSlotId: SlotId;
  toSlotId: SlotId;
  /**
   * 「にげる」として行ったか（T14）。
   * ポケモンいれかえ・あなぬけのヒモ等の入れ替えは にげる ではないので、
   * どちらなのかは操作した人が選ぶ。
   */
  asRetreat?: boolean;
}

/** 回収など。スロットのカードをまとめて指定ゾーンへ送る（サイドは動かさない） */
export interface RemovePokemonAction extends ActionBase {
  type: 'removePokemon';
  playerId: PlayerId;
  slotId: SlotId;
  toZone: Zone;
}

/**
 * きぜつを確定する（T16）。
 * 「場から出す」と「サイドをとる」を1つの操作にまとめてあるので、
 * 取り消し（T11）も1回で両方が戻る。
 *
 * ★prizeCount は ruleBox からの既定値ではなく、人が決めた値がそのまま入る。
 *   オルタージェネシスGX の +1、効果でサイドを取らないきぜつ、いずれも表現できる。
 */
export interface KnockOutAction extends ActionBase {
  type: 'knockOut';
  /** きぜつしたポケモンの持ち主 */
  playerId: PlayerId;
  slotId: SlotId;
  /**
   * ダイアログを出した時点で一番上だったカード。
   * 両者の同時確定や、確定待ちの間にバトル場が入れ替わった場合に、
   * 別のポケモンを誤ってきぜつさせないため照合する。
   */
  expectedTopInstanceId: string;
  /** サイドをとる側。null なら誰もとらない */
  prizePlayerId: PlayerId | null;
  prizeCount: number;
  /** 実際に手札へ移すサイドのカード。サイドは伏せられているのでサーバーが選ぶ */
  prizeCardIds: string[];
}

export interface AdjustDamageAction extends ActionBase {
  type: 'adjustDamage';
  playerId: PlayerId;
  slotId: SlotId;
  /** ダメカンの増減個数。+1 で10ダメージ。0 未満にはしない */
  delta: number;
}

/** T19の計算パネルで人が確認したダメージを、計算過程つきで適用する */
export interface ApplyDamageCalculationAction extends ActionBase {
  type: 'applyDamageCalculation';
  playerId: PlayerId;
  slotId: SlotId;
  /** パネルを開いた後に対象が入れ替わっていた場合の誤適用を防ぐ */
  expectedTopInstanceId: string;
  attackName: string;
  baseDamage: number;
  weaknessApplied: boolean;
  resistanceApplied: boolean;
  manualAdjustment: number;
  finalDamage: number;
  damageCounters: number;
}

export interface SetDamageAction extends ActionBase {
  type: 'setDamage';
  playerId: PlayerId;
  slotId: SlotId;
  counters: number;
}

export interface SetConditionAction extends ActionBase {
  type: 'setCondition';
  playerId: PlayerId;
  slotId: SlotId;
  condition: SpecialCondition;
  on: boolean;
}

export interface ClearConditionsAction extends ActionBase {
  type: 'clearConditions';
  playerId: PlayerId;
  slotId: SlotId;
}

export interface SetNotesAction extends ActionBase {
  type: 'setNotes';
  playerId: PlayerId;
  slotId: SlotId;
  notes: string;
}

/**
 * ワザを使ったことを宣言する（T15）。
 * ★効果もダメージも自動処理しない。「使った」という事実だけを残す。
 *   ダメージは T19 のダメージ計算アシストが別の操作として乗せる。
 */
export interface UseAttackAction extends ActionBase {
  type: 'useAttack';
  playerId: PlayerId;
  slotId: SlotId;
  attackIndex: number;
  /** ログ表示用。カード定義がなくても読めるようにする */
  attackName?: string;
  targetPlayerId?: PlayerId;
  targetSlotId?: SlotId;
}

/** 他カードのワザを参照させる（§5.1-3）。参照を積むだけで解決も実行もしない */
export interface GrantAttackAction extends ActionBase {
  type: 'grantAttack';
  playerId: PlayerId;
  slotId: SlotId;
  ref: AttackRef;
}

export interface ClearGrantedAttacksAction extends ActionBase {
  type: 'clearGrantedAttacks';
  playerId: PlayerId;
  slotId: SlotId;
}

// ── プレイヤー状態 ────────────────────

/** スカイフィールド8 / ウソッキー4 / ムゲンゾーン8（§5.1-1） */
export interface SetBenchLimitAction extends ActionBase {
  type: 'setBenchLimit';
  playerId: PlayerId;
  benchLimit: number;
}

/** サイド枚数は可変（§5.1-2） */
export interface SetPrizesAction extends ActionBase {
  type: 'setPrizes';
  playerId: PlayerId;
  prizesRemaining: number;
  prizesTotal?: number;
}

export interface SetTurnFlagAction extends ActionBase {
  type: 'setTurnFlag';
  playerId: PlayerId;
  /** ★真偽で持つ制限だけ。ワザの回数（attacksUsed）はここでは動かさない */
  flag: BooleanTurnFlag;
  value: boolean;
}

/**
 * 「対戦中1回」の枠を手で戻す／立てる（第4段階 T36）。
 * ★自動で立てはするが、直せないと詰む。効果で例外的にもう1回使えるカードがあるため。
 */
export interface SetOncePerGameUsedAction extends ActionBase {
  type: 'setOncePerGameUsed';
  playerId: PlayerId;
  kind: OncePerGameKind;
  value: boolean;
}

export interface SetPlayerNameAction extends ActionBase {
  type: 'setPlayerName';
  playerId: PlayerId;
  displayName: string;
}

// ── ターンとフェーズ ───────────────────

export interface SetPhaseAction extends ActionBase {
  type: 'setPhase';
  phase: GameState['phase'];
}

/** turnQueue の先頭を消費して次の番へ。ループではなく配列（§5.1-4） */
export interface EndTurnAction extends ActionBase {
  type: 'endTurn';
}

/** サーバーが現在の盤面と、番開始時のドロー失敗をもとに勝敗条件を検出する（T18） */
export interface DetectDefeatAction extends ActionBase {
  type: 'detectDefeat';
  turnStartDrawFailedPlayerId?: PlayerId;
}

/** 検出済みの結果を各プレイヤーが確認する。両者確認までは試合を終了しない */
export interface ConfirmGameEndAction extends ActionBase {
  type: 'confirmGameEnd';
  playerId: PlayerId;
  proposalId: string;
}

/** サーバーがポケモンチェックの現在対象を1件解決する（T17） */
export interface ResolvePokemonCheckTargetAction extends ActionBase {
  type: 'resolvePokemonCheckTarget';
  order: 1 | 2 | 3 | 4;
  playerId: PlayerId;
  slotId: SlotId;
  expectedTopInstanceId: string;
  /** どくの既定は1。バッドポイズン等に合わせて人が変更できる */
  poisonCounters?: number;
  /** やけど・ねむりだけ。結果とseedはサーバーが確定する */
  coinResult?: 'heads' | 'tails';
  /** 未実装効果などの例外を人が処理するときは、盤面を変えず解決済みにする */
  skip?: boolean;
}

/** 追加ターン（スタークロノス等）を turnQueue に差し込む */
export interface InsertExtraTurnAction extends ActionBase {
  type: 'insertExtraTurn';
  playerId: PlayerId;
  /** turnQueue のどこに入れるか。省略時は次の番 */
  atIndex?: number;
  /** 'スタークロノス' など。履歴に残る */
  source?: string;
}

export interface SetActivePlayerAction extends ActionBase {
  type: 'setActivePlayer';
  playerId: PlayerId;
}

// ── 対戦準備（T10） ───────────────────

export interface SetSetupStepAction extends ActionBase {
  type: 'setSetupStep';
  step: SetupStep;
}

export interface SetJankenWinnerAction extends ActionBase {
  type: 'setJankenWinner';
  playerId: PlayerId | null;
}

/** 先攻を決める。turnQueue もこの順に組み直す */
export interface SetFirstPlayerAction extends ActionBase {
  type: 'setFirstPlayer';
  playerId: PlayerId;
}

/** マリガン1回ぶんを記録する。引き直し自体は shuffleIntoDeck + drawCards で行う */
export interface RecordMulliganAction extends ActionBase {
  type: 'recordMulligan';
  playerId: PlayerId;
}

/** 相手のマリガンに対する追加ドローの宣言（枚数だけ。実際に引くのは drawCards） */
export interface DeclareBonusDrawAction extends ActionBase {
  type: 'declareBonusDraw';
  playerId: PlayerId;
  count: number;
}

export interface SetSetupReadyAction extends ActionBase {
  type: 'setSetupReady';
  playerId: PlayerId;
  ready: boolean;
}

// ── スタジアム ───────────────────────

export interface SetStadiumAction extends ActionBase {
  type: 'setStadium';
  /** null で場から外す。外れたカードの行き先は別途 moveCard で指定する */
  cardId: string | null;
}

// ── 乱数（結果はサーバーが決めて載せる） ────

export type CoinFace = 'heads' | 'tails';

export interface FlipCoinAction extends ActionBase {
  type: 'flipCoin';
  playerId: PlayerId;
  /** サーバーが出した結果 */
  results: CoinFace[];
  /** 「ワザの効果で」「にげる代わりに」など、何のためのコインか */
  reason?: string;
}

/** じゃんけん・ランダム選択の汎用。盤面は変えずログにだけ残す */
export interface RandomChoiceAction extends ActionBase {
  type: 'randomChoice';
  label: string;
  options: string[];
  /** サーバーが選んだ結果 */
  result: string;
}

/** 手動でログに一言残す（メモ・口頭確認の記録） */
export interface NoteAction extends ActionBase {
  type: 'note';
  text: string;
}

// ── カード効果の実行（第3段階 T24） ─────────

/**
 * 効果の実行を始める。
 * ★実行状態を GameState に置くので、途中で切断しても続きから再開できる（§2.1）。
 */
export interface StartEffectAction extends ActionBase {
  type: 'startEffect';
  executionId: string;
  /** 展開前のオペコード列。展開は applyAction の中で行う */
  ops: Op[];
  source: EffectSource;
}

/**
 * 実行を1オペコードだけ進める。
 * ★乱数の結果は rolls に載って渡ってくる（§4.2）。
 *   ログに残るのでこの操作は再現できるし、Undo でも戻せる。
 */
export interface EffectStepAction extends ActionBase {
  type: 'effectStep';
  /** 取り違え防止。いま動いている実行と一致しなければ何もしない */
  executionId: string;
  rolls?: EffectRolls;
}

/**
 * 応答待ちの選択に答える（T25）。
 * ★一時公開の巻き戻しもこの操作の中で行う。Undo で戻せば公開状態も戻る。
 */
export interface ResolveChoiceAction extends ActionBase {
  type: 'resolveChoice';
  requestId: string;
  /** 選んだカード。confirm（manual の確認）のときは空配列 */
  selected: string[];
  /** thenShuffle があるときの並び。サーバーが決める（§4.2） */
  rolls?: EffectRolls;
}

/**
 * かかっている効果を手で外す（T26）。
 * ★自動判定が取りこぼしたとき、卓が進まなくならないための逃げ道。
 *   効果の可視化（§5.2）のバッジからそのまま外せる。
 */
export interface RemoveEffectAction extends ActionBase {
  type: 'removeEffect';
  effectId: string;
  /**
   * ログに出す説明。
   * ★要約は「効果を外したあとの状態」から作られるので、外した効果はもう引けない。
   *   何を外したのかを残すために、外す側が文言を添える。
   */
  label?: string;
}

/**
 * 実行を打ち切る。
 * ★逃げ道（§7-5）。自動化できない場面に当たっても卓が固まらないようにする。
 */
export interface CancelEffectAction extends ActionBase {
  type: 'cancelEffect';
  reason?: string;
}

// ── union ───────────────────────────

export type Action =
  | AddPlayerAction
  | RequestUndoAction
  | ResolveUndoAction
  | SetupDeckAction
  | MoveCardAction
  | ShuffleDeckAction
  | ShuffleIntoDeckAction
  | DrawCardsAction
  | SetFaceUpAction
  | SetCardVisibilityAction
  | PlacePokemonAction
  | EvolvePokemonAction
  | AssembleVUnionAction
  | DevolvePokemonAction
  | AttachCardAction
  | DetachCardAction
  | MovePokemonAction
  | RemovePokemonAction
  | KnockOutAction
  | AdjustDamageAction
  | ApplyDamageCalculationAction
  | SetDamageAction
  | SetConditionAction
  | ClearConditionsAction
  | SetNotesAction
  | UseAttackAction
  | GrantAttackAction
  | ClearGrantedAttacksAction
  | SetBenchLimitAction
  | SetPrizesAction
  | SetTurnFlagAction
  | SetOncePerGameUsedAction
  | SetPlayerNameAction
  | SetPhaseAction
  | EndTurnAction
  | DetectDefeatAction
  | ConfirmGameEndAction
  | ResolvePokemonCheckTargetAction
  | InsertExtraTurnAction
  | SetActivePlayerAction
  | SetSetupStepAction
  | SetJankenWinnerAction
  | SetFirstPlayerAction
  | RecordMulliganAction
  | DeclareBonusDrawAction
  | SetSetupReadyAction
  | SetStadiumAction
  | FlipCoinAction
  | RandomChoiceAction
  | NoteAction
  | StartEffectAction
  | EffectStepAction
  | ResolveChoiceAction
  | RemoveEffectAction
  | CancelEffectAction;

export type ActionType = Action['type'];

// ── 内部ヘルパ ───────────────────────

/**
 * 始まった番を履歴に残す（T13）。
 * その番が追加ターンかどうかは turnQueueMeta の先頭が持っている。
 */
function recordTurn(state: GameState, playerId: PlayerId): void {
  const meta = state.turnQueueMeta[0];
  const record: TurnRecord = {
    turn: state.turn,
    playerId,
    isExtra: meta?.isExtra ?? false,
  };
  if (meta?.source) record.source = meta.source;
  state.turnHistory.push(record);
}

/**
 * 追加の番を列に差し込む（T41）。
 * ★省略時は「次の番」。先頭は進行中の番なので index は 1 から。
 */
function insertExtraTurnInto(
  state: GameState,
  playerId: PlayerId,
  source: string | null,
  atIndex?: number,
): void {
  const index = Math.max(0, Math.min(atIndex ?? 1, state.turnQueue.length));
  state.turnQueue.splice(index, 0, playerId);
  state.turnQueueMeta.splice(index, 0, { isExtra: true, source });
}

function requireSetup(state: GameState) {
  if (!state.setup) throw new ActionError('対戦準備が始まっていません');
  return state.setup;
}

function setupProgress(state: GameState, playerId: PlayerId): SetupProgress {
  const setup = requireSetup(state);
  const existing = setup.progress[playerId];
  if (existing) return existing;
  const created: SetupProgress = { mulligans: 0, bonusDraw: null, ready: false };
  setup.progress[playerId] = created;
  return created;
}

// ── ログ ─────────────────────────────

const ZONE_LABEL: Record<Zone, string> = {
  deck: '山札',
  hand: '手札',
  active: 'バトル場',
  bench: 'ベンチ',
  prize: 'サイド',
  discard: 'トラッシュ',
  lost: 'ロストゾーン',
  stadium: 'スタジアム',
};

const CONDITION_LABEL: Record<SpecialCondition, string> = {
  poisoned: 'どく',
  burned: 'やけど',
  asleep: 'ねむり',
  paralyzed: 'マヒ',
  confused: 'こんらん',
};

const FLAG_LABEL: Record<BooleanTurnFlag, string> = {
  energyAttached: 'エネルギー',
  supporterUsed: 'サポート',
  stadiumPlayed: 'スタジアム',
  retreated: 'にげる',
};

/** 'active' → 'バトル場'、'bench-0' → 'ベンチ1' */
const slotLabel = (slotId: SlotId): string =>
  slotId === 'active' ? 'バトル場' : `ベンチ${Number(slotId.slice('bench-'.length)) + 1}`;

export const SETUP_STEP_LABEL: Record<SetupStep, string> = {
  janken: 'じゃんけん',
  order: '先攻・後攻を決める',
  draw: '山札を切って7枚引く',
  mulligan: 'たね確認とマリガン',
  place: 'バトル場とベンチにウラで出す',
  prizes: 'サイドを置く',
  reveal: 'いっせいにオモテにする',
  done: '準備完了',
};

/** 場のスロットが使おうとしているワザの定義。見えない・定義がなければ undefined */
function attackOf(
  state: GameState,
  ctx: RuleContext,
  playerId: PlayerId,
  slotId: SlotId,
  attackIndex: number,
): Attack | undefined {
  const slot = state.players[playerId]?.pokemon.find((p) => p.slotId === slotId);
  return cardOf(state, ctx, slot?.stack[slot.stack.length - 1])?.attacks?.[attackIndex];
}

const nameOf = (state: GameState, playerId: PlayerId): string =>
  state.players[playerId]?.displayName ?? playerId;

/**
 * ログ1行の要約。
 * ★ここではカード名を出さない。カード名は隠匿情報なので、
 *   クライアントが自分に見えている範囲で Action から組み立てて表示する。
 */
export function describeAction(state: GameState, action: Action): string {
  const who = action.actorId === 'server' ? 'システム' : nameOf(state, action.actorId);
  switch (action.type) {
    case 'addPlayer':
      return `${action.displayName}が卓についた`;
    case 'requestUndo':
      return `${who}が ${action.targetSeq} 番以降の取り消しを要求した`;
    case 'resolveUndo':
      return action.approved
        ? `${who}が取り消しを承認した（${action.targetSeq} 番以降を巻き戻した）`
        : `${who}が取り消しを断った`;
    case 'setupDeck':
      return `${nameOf(state, action.playerId)}が${action.cards.length}枚の山札を置いた`;
    case 'moveCard':
      return `${who}がカードを${ZONE_LABEL[action.toZone]}へ移した`;
    case 'shuffleDeck':
      return `${nameOf(state, action.playerId)}の山札をシャッフルした`;
    case 'shuffleIntoDeck':
      return `${nameOf(state, action.playerId)}がカード${action.cardIds.length}枚を山札に加えて切った`;
    case 'drawCards':
      return `${nameOf(state, action.playerId)}が山札を${action.cardIds.length}枚引いた`;
    case 'setFaceUp':
      return `${who}がカードを${action.faceUp ? 'オモテ' : 'ウラ'}にした`;
    case 'setCardVisibility':
      return `${who}がカード${action.cardIds.length}枚の公開範囲を変えた`;
    case 'placePokemon':
      return `${nameOf(state, action.playerId)}が${slotLabel(action.slotId)}にポケモンを出した`;
    case 'evolvePokemon':
      return `${nameOf(state, action.playerId)}が${slotLabel(action.slotId)}のポケモンを進化させた`;
    case 'devolvePokemon':
      return `${nameOf(state, action.playerId)}が${slotLabel(action.slotId)}のポケモンを退化させた`;
    case 'attachCard':
      return `${nameOf(state, action.playerId)}が${slotLabel(action.slotId)}に${action.as === 'energy' ? 'エネルギー' : 'どうぐ'}をつけた`;
    case 'detachCard':
      return `${nameOf(state, action.playerId)}が${slotLabel(action.slotId)}からカードを外して${ZONE_LABEL[action.toZone]}へ送った`;
    case 'movePokemon':
      return `${nameOf(state, action.playerId)}が${slotLabel(action.fromSlotId)}と${slotLabel(action.toSlotId)}を入れ替えた`;
    case 'removePokemon':
      return `${nameOf(state, action.playerId)}が${slotLabel(action.slotId)}のポケモンを${ZONE_LABEL[action.toZone]}へ送った`;
    case 'knockOut': {
      const prize =
        action.prizePlayerId && action.prizeCount > 0
          ? `${nameOf(state, action.prizePlayerId)}がサイドを${action.prizeCount}枚とった`
          : 'サイドは取られなかった';
      return `${nameOf(state, action.playerId)}の${slotLabel(action.slotId)}がきぜつ（トラッシュへ / ${prize}）`;
    }
    case 'adjustDamage':
      return `${nameOf(state, action.playerId)}の${slotLabel(action.slotId)}のダメカンが${action.delta >= 0 ? '+' : ''}${action.delta}個`;
    case 'applyDamageCalculation': {
      const modifiers = [
        action.weaknessApplied ? '弱点' : null,
        action.resistanceApplied ? '抵抗力' : null,
        action.manualAdjustment !== 0
          ? `手動${action.manualAdjustment >= 0 ? '+' : ''}${action.manualAdjustment}`
          : null,
      ].filter(Boolean);
      return `${nameOf(state, action.playerId)}の${slotLabel(action.slotId)}に「${action.attackName}」で${action.finalDamage}ダメージ（基礎${action.baseDamage}${modifiers.length ? ` / ${modifiers.join(' / ')}` : ''}）`;
    }
    case 'setDamage':
      return `${nameOf(state, action.playerId)}の${slotLabel(action.slotId)}のダメカンを${action.counters}個にした`;
    case 'setCondition':
      return `${nameOf(state, action.playerId)}の${slotLabel(action.slotId)}の「${CONDITION_LABEL[action.condition]}」を${action.on ? '付与' : '解除'}した`;
    case 'clearConditions':
      return `${nameOf(state, action.playerId)}の${slotLabel(action.slotId)}の特殊状態をすべて回復した`;
    case 'setNotes':
      return `${nameOf(state, action.playerId)}が${slotLabel(action.slotId)}にメモを書いた`;
    case 'useAttack':
      return `${nameOf(state, action.playerId)}が${slotLabel(action.slotId)}のワザ${
        action.attackName ? `「${action.attackName}」` : ''
      }を使った`;
    case 'grantAttack':
      return `${nameOf(state, action.playerId)}の${slotLabel(action.slotId)}が他のカードのワザを参照した`;
    case 'clearGrantedAttacks':
      return `${nameOf(state, action.playerId)}の${slotLabel(action.slotId)}のワザ参照を解除した`;
    case 'setBenchLimit':
      return `${nameOf(state, action.playerId)}のベンチ上限が${action.benchLimit}になった`;
    case 'setPrizes':
      return `${nameOf(state, action.playerId)}のサイドが残り${action.prizesRemaining}枚になった`;
    case 'setTurnFlag':
      return `${nameOf(state, action.playerId)}の「${FLAG_LABEL[action.flag]}」を${action.value ? '使用済み' : '未使用'}にした`;
    case 'assembleVUnion':
      return `${nameOf(state, action.playerId)}が${slotLabel(action.slotId)}に V-UNION を組み立てた（${action.cardIds.length}枚）`;
    case 'setOncePerGameUsed':
      return `${nameOf(state, action.playerId)}の「${ONCE_PER_GAME_LABEL[action.kind]}」を${
        action.value ? '使用済み' : '未使用'
      }にした`;
    case 'setPlayerName':
      return `${action.playerId}の表示名を「${action.displayName}」にした`;
    case 'setPhase':
      return `フェーズが${action.phase}になった`;
    case 'endTurn':
      return `${who}が番を終了した`;
    case 'detectDefeat': {
      const result = state.gameEnd;
      if (!result) return '勝敗条件を確認した';
      return result.outcome === 'draw'
        ? '勝敗条件を同時に検出（引き分け・両者確認待ち）'
        : `${nameOf(state, result.winnerId ?? '')}の勝利条件を検出（両者確認待ち）`;
    }
    case 'confirmGameEnd':
      return state.phase === 'ended'
        ? `${nameOf(state, action.playerId)}が結果を確認し、対戦が終了した`
        : `${nameOf(state, action.playerId)}が対戦結果を確認した`;
    case 'resolvePokemonCheckTarget': {
      const condition = ['','どく', 'やけど', 'ねむり', 'マヒ'][action.order];
      if (action.skip) {
        return `${nameOf(state, action.playerId)}の${slotLabel(action.slotId)}の${condition}処理をスキップした`;
      }
      if (action.order === 1) {
        return `${nameOf(state, action.playerId)}の${slotLabel(action.slotId)}に、どくでダメカンを${Math.max(0, action.poisonCounters ?? 1)}個のせた`;
      }
      if (action.order === 2 || action.order === 3) {
        return `${nameOf(state, action.playerId)}の${slotLabel(action.slotId)}の${condition}を処理（コイン${action.coinResult === 'heads' ? 'オモテ' : 'ウラ'}）`;
      }
      return `${nameOf(state, action.playerId)}の${slotLabel(action.slotId)}のマヒが回復した`;
    }
    case 'insertExtraTurn':
      return `${nameOf(state, action.playerId)}の追加の番が挿入された${
        action.source ? `（${action.source}）` : ''
      }`;
    case 'setActivePlayer':
      return `手番が${nameOf(state, action.playerId)}になった`;
    case 'setSetupStep':
      return `対戦準備: ${SETUP_STEP_LABEL[action.step]}`;
    case 'setJankenWinner':
      return action.playerId
        ? `じゃんけんは${nameOf(state, action.playerId)}の勝ち`
        : 'じゃんけんをやり直す';
    case 'setFirstPlayer':
      return `${nameOf(state, action.playerId)}が先攻`;
    case 'recordMulligan':
      return `${nameOf(state, action.playerId)}がマリガン（たねポケモンなし）`;
    case 'declareBonusDraw':
      return action.count > 0
        ? `${nameOf(state, action.playerId)}が追加で${action.count}枚引くと宣言した`
        : `${nameOf(state, action.playerId)}は追加ドローをしない`;
    case 'setSetupReady':
      return `${nameOf(state, action.playerId)}が${action.ready ? '準備完了' : '準備中に戻った'}`;
    case 'setStadium':
      return action.cardId ? 'スタジアムが出された' : 'スタジアムが場を離れた';
    case 'flipCoin':
      return `${nameOf(state, action.playerId)}のコイン: ${action.results
        .map((r) => (r === 'heads' ? 'オモテ' : 'ウラ'))
        .join(' ')}${action.reason ? `（${action.reason}）` : ''}`;
    case 'randomChoice':
      // 選択肢がプレイヤーなら表示名にする（じゃんけん等）
      return `${action.label}: ${state.players[action.result] ? nameOf(state, action.result) : action.result}`;
    case 'note':
      return `${who}: ${action.text}`;
    case 'startEffect':
      return `${action.source.label}の効果がはたらいた`;
    case 'effectStep': {
      const op = state.execution?.ops[state.execution.cursor];
      return `効果の処理${op ? `（${op.op}）` : ''}`;
    }
    case 'resolveChoice': {
      const choice = state.execution?.pendingChoice;
      const count = action.selected.length;
      if (choice?.kind === 'confirm') return `${who}が「${choice.prompt}」を確認した`;
      return `${who}がカードを${count}枚選んだ`;
    }
    case 'removeEffect':
      return `${who}が「${action.label ?? '効果'}」を外した`;
    case 'cancelEffect':
      return `効果の自動処理を打ち切った${action.reason ? `（${action.reason}）` : ''}`;
  }
}

function appendLog(state: GameState, action: Action, warnings: RuleWarning[]): void {
  const entry: LogEntry = {
    seq: (state.log[state.log.length - 1]?.seq ?? 0) + 1,
    at: action.at,
    actorId: action.actorId,
    action,
    summary: describeAction(state, action),
    visibleTo: action.logVisibleTo ?? playerIdsOf(state),
    undone: false,
    warnings,
  };
  if (action.seed !== undefined) entry.seed = action.seed;
  state.log.push(entry);
}

// ── 適用 ─────────────────────────────

/**
 * 原子操作を1つ適用して新しい状態を返す。
 *
 * ★ルール違反で操作を止めることはしない（第2段階 §2）。
 *   ctx にカード定義を渡すと、ルール警告をログに残しつつ操作は通す。
 *   参照先が存在しない等、構造的な誤りだけ ActionError を投げる。
 */
export function applyAction(
  state: GameState,
  action: Action,
  ctx: RuleContext = {},
): GameState {
  // 検査と副作用の判定は「適用前」の状態に対して行う
  const warnings = checkAction(state, action, ctx);
  const flagUpdates = turnFlagUpdates(state, action, ctx);

  const next = structuredClone(state);
  mutate(next, action, ctx);

  /*
   * 効果の掃除（T26）。
   * ★毎回の操作のあとに必ず通す。ここを1か所にまとめておかないと、
   *   きぜつ・回収・場を離れる といった経路のどれかで消し忘れが必ず起きる。
   */
  sweepEffects(next);

  // 1ターン制限の使用済みマーク（T14）。手で戻せる
  for (const { playerId, flag } of flagUpdates) {
    const player = next.players[playerId];
    if (player) player.turnFlags[flag] = true;
  }

  // ★ロックが2つ以上になったら、その瞬間を記録に残す（§2.1 / T42）
  const lockNotice = multipleLockNotice(state, next, ctx);
  if (lockNotice) warnings.push(lockNotice);

  appendLog(next, action, warnings);
  return next;
}

/**
 * 第2段階 §2 の ActionResult を返す版。
 * 警告は state のログにも入っているので、相手にも同じものが見える。
 */
export function applyActionChecked(
  state: GameState,
  action: Action,
  ctx: RuleContext = {},
): ActionResult {
  const nextState = applyAction(state, action, ctx);
  return {
    state: nextState,
    warnings: nextState.log[nextState.log.length - 1]?.warnings ?? [],
  };
}

/** 続けて適用する（対戦準備のような一連の操作の再生に使う） */
export function applyActions(
  state: GameState,
  actions: readonly Action[],
  ctx: RuleContext = {},
): GameState {
  return actions.reduce<GameState>((s, a) => applyAction(s, a, ctx), state);
}

function mutate(state: GameState, action: Action, ctx: RuleContext): void {
  switch (action.type) {
    case 'addPlayer': {
      const existing = state.players[action.playerId];
      if (existing) {
        existing.displayName = action.displayName;
        return;
      }
      state.players[action.playerId] = {
        playerId: action.playerId,
        displayName: action.displayName,
        pokemon: [],
        benchLimit: action.benchLimit ?? 5,
        prizesRemaining: action.prizes ?? 6,
        prizesTotal: action.prizes ?? 6,
        oncePerGameUsed: [],
        turnFlags: {
          energyAttached: false,
          supporterUsed: false,
          stadiumPlayed: false,
          retreated: false,
          attacksUsed: 0,
        },
      };
      state.turnQueue.push(action.playerId);
      state.turnQueueMeta.push({ isExtra: false, source: null });
      if (!state.activePlayer) state.activePlayer = action.playerId;
      if (state.setup) {
        state.setup.progress[action.playerId] = { mulligans: 0, bonusDraw: null, ready: false };
      }
      return;
    }

    case 'requestUndo': {
      if (action.actorId === 'server') throw new ActionError('取り消しは人が要求します');
      state.pendingUndo = {
        requestId: `u${action.targetSeq}-${action.at}`,
        targetSeq: action.targetSeq,
        requestedBy: action.actorId,
        status: 'pending',
      };
      return;
    }

    case 'resolveUndo': {
      // 巻き戻し自体はサーバーが状態を差し替えて行う。ここは要求を片付けるだけ
      state.pendingUndo = null;
      return;
    }

    case 'setupDeck': {
      const player = getPlayer(state, action.playerId);
      player.pokemon = [];
      for (const card of Object.values(state.cards)) {
        if (card.ownerId === action.playerId) delete state.cards[card.instanceId];
      }
      action.cards.forEach((card, i) => {
        state.cards[card.instanceId] = {
          instanceId: card.instanceId,
          functionalId: card.functionalId,
          ownerId: action.playerId,
          zone: 'deck',
          visibleTo: [],
          faceUp: false,
          position: i,
        };
      });
      return;
    }

    case 'moveCard': {
      const visibility: { visibleTo?: PlayerId[]; faceUp?: boolean } = {};
      if (action.visibleTo !== undefined) visibility.visibleTo = action.visibleTo;
      if (action.faceUp !== undefined) visibility.faceUp = action.faceUp;
      relocate(state, action.cardId, action.toZone, action.insertAt ?? 'bottom', visibility);
      return;
    }

    case 'shuffleDeck': {
      const conceal = action.conceal ?? true;
      action.order.forEach((id, i) => {
        const card = getCard(state, id);
        card.position = i;
        if (conceal) {
          card.visibleTo = [];
          card.faceUp = false;
        }
      });
      return;
    }

    case 'shuffleIntoDeck': {
      for (const id of action.cardIds) {
        relocate(state, id, 'deck', 'bottom');
      }
      action.order.forEach((id, i) => {
        const card = getCard(state, id);
        card.position = i;
        card.visibleTo = [];
        card.faceUp = false;
      });
      return;
    }

    case 'drawCards': {
      for (const id of action.cardIds) {
        relocate(state, id, 'hand', 'bottom', { visibleTo: [action.playerId], faceUp: false });
      }
      return;
    }

    case 'setFaceUp': {
      getCard(state, action.cardId).faceUp = action.faceUp;
      return;
    }

    case 'setCardVisibility': {
      for (const id of action.cardIds) {
        getCard(state, id).visibleTo = [...action.visibleTo];
      }
      return;
    }

    case 'placePokemon': {
      const player = getPlayer(state, action.playerId);
      if (player.pokemon.some((p) => p.slotId === action.slotId)) {
        throw new ActionError(`スロットが埋まっています: ${action.slotId}`);
      }
      const zone = zoneForSlot(action.slotId);
      const faceUp = action.faceUp ?? true;
      relocate(state, action.cardId, zone, 'bottom', {
        faceUp,
        // ウラのまま出したなら誰にも見えない（対戦準備）
        visibleTo: faceUp ? playerIdsOf(state) : [],
      });
      const slot: PokemonInPlay = {
        slotId: action.slotId,
        stack: [action.cardId],
        attachedEnergy: [],
        attachedTool: null,
        damageCounters: 0,
        conditions: [],
        placedOnTurn: state.turn,
        evolvedOnTurn: null,
        devolvedOnTurn: null,
        grantedAttacks: [],
        notes: '',
      };
      player.pokemon.push(slot);
      return;
    }

    case 'assembleVUnion': {
      const player = getPlayer(state, action.playerId);
      if (player.pokemon.some((p) => p.slotId === action.slotId)) {
        throw new ActionError(`スロットが埋まっています: ${action.slotId}`);
      }
      if (action.cardIds.length === 0) throw new ActionError('組み立てるカードがありません');

      const zone = zoneForSlot(action.slotId);
      for (const cardId of action.cardIds) {
        relocate(state, cardId, zone, 'bottom', { faceUp: true, visibleTo: playerIdsOf(state) });
      }
      player.pokemon.push({
        slotId: action.slotId,
        // ★4枚を1つのスタックに。並び順は組み立てた順（1枚目〜4枚目）
        stack: [...action.cardIds],
        attachedEnergy: [],
        attachedTool: null,
        damageCounters: 0,
        conditions: [],
        placedOnTurn: state.turn,
        // 進化ではないので、進化まわりの記録は立てない
        evolvedOnTurn: null,
        devolvedOnTurn: null,
        grantedAttacks: [],
        notes: '',
      });
      // ★対戦中1回。プレイヤー単位（T36 の枠を使う）
      markOncePerGameUsed(state, action.playerId, 'vunion');
      return;
    }

    case 'evolvePokemon': {
      // 進化先のスロットが存在することだけ先に確かめる
      getSlot(state, action.playerId, action.slotId);
      relocate(state, action.cardId, zoneForSlot(action.slotId), 'bottom', {
        faceUp: true,
        visibleTo: playerIdsOf(state),
      });
      // relocate 内の detachEverywhere で slot が消えている可能性があるため取り直す
      const target = getSlot(state, action.playerId, action.slotId);
      target.stack.push(action.cardId);
      target.evolvedOnTurn = state.turn;
      syncSlotZones(state, target);
      // ★進化で特殊状態とかかっている効果は消える（エネ・どうぐ・ダメカンは引きつぐ）
      target.conditions = [];
      expireOnEvent(state, {
        kind: 'evolves',
        slotKey: effectSlotKey(action.playerId, action.slotId),
      });
      return;
    }

    case 'devolvePokemon': {
      const slot = getSlot(state, action.playerId, action.slotId);
      const top = slot.stack[slot.stack.length - 1];
      if (top === undefined) throw new ActionError(`進化スタックが空です: ${action.slotId}`);
      relocate(state, top, action.toZone);
      const remaining = getPlayer(state, action.playerId).pokemon.find(
        (p) => p.slotId === action.slotId,
      );
      if (remaining) {
        remaining.devolvedOnTurn = state.turn;
        // ★退化でも特殊状態とかかっている効果は消える（§3.2）
        remaining.conditions = [];
      }
      expireOnEvent(state, {
        kind: 'devolves',
        slotKey: effectSlotKey(action.playerId, action.slotId),
      });
      return;
    }

    case 'attachCard': {
      // つける先が存在することだけ先に確かめる
      getSlot(state, action.playerId, action.slotId);
      relocate(state, action.cardId, zoneForSlot(action.slotId), 'bottom', {
        faceUp: true,
        visibleTo: playerIdsOf(state),
      });
      const target = getSlot(state, action.playerId, action.slotId);
      if (action.as === 'energy') target.attachedEnergy.push(action.cardId);
      else target.attachedTool = action.cardId;
      syncSlotZones(state, target);

      /*
       * ★「相手の番の終わりにトラッシュする」を効果として立てる（T40）。
       *   クレッフィのように **カードの役割が動的に変わる** ものは、
       *   いつ外れるかを状態に持っておかないと必ず置き忘れる。
       */
      if (action.until === 'endOfNextOpponentTurn') {
        const attacher = state.cards[action.cardId]?.ownerId ?? action.playerId;
        state.effects.push({
          effectId: `tmptool-${action.cardId}-${state.turn}`,
          source: {
            instanceId: action.cardId,
            playerId: attacher,
            label: cardOf(state, ctx, action.cardId)?.name ?? 'どうぐ化したカード',
          },
          target: { slotId: effectSlotKey(action.playerId, action.slotId) },
          applyAt: 'none',
          kind: 'temporaryTool',
          payload: { instanceId: action.cardId, label: '相手の番の終わりにトラッシュ' },
          duration: { type: 'untilEndOfNextOpponentTurn' },
          expiresOn: [],
          createdOnTurn: state.turn,
        });
      }
      return;
    }

    case 'detachCard': {
      getSlot(state, action.playerId, action.slotId);
      relocate(state, action.cardId, action.toZone);
      return;
    }

    case 'movePokemon': {
      const player = getPlayer(state, action.playerId);
      const from = player.pokemon.find((p) => p.slotId === action.fromSlotId);
      if (!from) throw new ActionError(`スロットが空です: ${action.fromSlotId}`);
      const to = player.pokemon.find((p) => p.slotId === action.toSlotId);
      from.slotId = action.toSlotId;
      if (to) to.slotId = action.fromSlotId;
      syncSlotZones(state, from);
      if (to) syncSlotZones(state, to);

      /*
       * ★ベンチに戻る / 入れ替わる → 特殊状態・かかっている効果すべて消える（§3.2）。
       *   スロットは動いても効果は「その場所にかかっていた」ものなので、
       *   移動元・移動先の両方のキーで落とす。
       */
      for (const slotId of [action.fromSlotId, action.toSlotId]) {
        expireOnEvent(state, {
          kind: 'returnsToBench',
          slotKey: effectSlotKey(action.playerId, slotId),
        });
      }
      clearConditionsOffActive(state);
      return;
    }

    case 'removePokemon': {
      const slot = getSlot(state, action.playerId, action.slotId);
      const cardIds = [...slot.stack, ...slot.attachedEnergy];
      if (slot.attachedTool) cardIds.push(slot.attachedTool);
      for (const id of cardIds) {
        relocate(state, id, action.toZone);
      }
      const player = getPlayer(state, action.playerId);
      player.pokemon = player.pokemon.filter((p) => p.slotId !== action.slotId);
      return;
    }

    case 'knockOut': {
      /*
       * ★スロットが空でも投げない。
       *   きぜつの確認ダイアログは両者に出るので、二人がほぼ同時に確定を押すことがある。
       *   後から届いたほうは何もしないのが正しい（エラーで止めるとかえって混乱する）。
       */
      const player = getPlayer(state, action.playerId);
      const slot = player.pokemon.find((p) => p.slotId === action.slotId);
      const currentTop = slot?.stack[slot.stack.length - 1];
      // すでに処理済み、または同じスロットに別のポケモンがいる古い要求は全体を no-op にする。
      // サイドだけ二重に取ることもない。
      if (!slot || currentTop !== action.expectedTopInstanceId) return;

      // 進化スタック全体・エネルギー・どうぐをまとめて持ち主のところへ送る
      const cardIds = [...slot.stack, ...slot.attachedEnergy];
      if (slot.attachedTool) cardIds.push(slot.attachedTool);
      for (const id of cardIds) {
        // ★プリズムスターだけトラッシュではなくロストゾーンへ（T36）
        relocate(state, id, discardZoneFor(cardOf(state, ctx, id)?.ruleBox));
      }
      player.pokemon = player.pokemon.filter((p) => p.slotId !== action.slotId);

      const taker = action.prizePlayerId ? state.players[action.prizePlayerId] : undefined;
      if (taker) {
        for (const id of action.prizeCardIds) {
          relocate(state, id, 'hand', 'bottom', {
            visibleTo: [taker.playerId],
            faceUp: false,
          });
        }
        taker.prizesRemaining = Math.max(0, taker.prizesRemaining - action.prizeCount);
      }
      return;
    }

    case 'adjustDamage': {
      const slot = getSlot(state, action.playerId, action.slotId);
      slot.damageCounters = Math.max(0, slot.damageCounters + action.delta);
      return;
    }

    case 'applyDamageCalculation': {
      const slot = getSlot(state, action.playerId, action.slotId);
      if (slot.stack.at(-1) !== action.expectedTopInstanceId) return;
      slot.damageCounters = Math.max(0, slot.damageCounters + Math.max(0, action.damageCounters));
      return;
    }

    case 'setDamage': {
      getSlot(state, action.playerId, action.slotId).damageCounters = Math.max(0, action.counters);
      return;
    }

    case 'setCondition': {
      const slot = getSlot(state, action.playerId, action.slotId);
      const has = slot.conditions.includes(action.condition);
      if (action.on && !has) slot.conditions.push(action.condition);
      if (!action.on && has) {
        slot.conditions = slot.conditions.filter(
          (c: SpecialCondition) => c !== action.condition,
        );
      }
      return;
    }

    case 'clearConditions': {
      getSlot(state, action.playerId, action.slotId).conditions = [];
      return;
    }

    case 'setNotes': {
      getSlot(state, action.playerId, action.slotId).notes = action.notes;
      return;
    }

    case 'grantAttack': {
      getSlot(state, action.playerId, action.slotId).grantedAttacks.push({ ...action.ref });
      return;
    }

    case 'clearGrantedAttacks': {
      getSlot(state, action.playerId, action.slotId).grantedAttacks = [];
      return;
    }

    case 'setBenchLimit': {
      getPlayer(state, action.playerId).benchLimit = action.benchLimit;
      return;
    }

    case 'setPrizes': {
      const player = getPlayer(state, action.playerId);
      player.prizesRemaining = Math.max(0, action.prizesRemaining);
      if (action.prizesTotal !== undefined) player.prizesTotal = action.prizesTotal;
      return;
    }

    case 'setTurnFlag': {
      getPlayer(state, action.playerId).turnFlags[action.flag] = action.value;
      return;
    }

    case 'setOncePerGameUsed': {
      const player = getPlayer(state, action.playerId);
      player.oncePerGameUsed = action.value
        ? [...new Set([...player.oncePerGameUsed, action.kind])]
        : player.oncePerGameUsed.filter((kind) => kind !== action.kind);
      return;
    }

    case 'setPlayerName': {
      getPlayer(state, action.playerId).displayName = action.displayName;
      return;
    }

    case 'setPhase': {
      if (action.phase === 'pokemonCheck') {
        // 同じフェーズを再送しても進行を巻き戻さない。
        if (state.phase !== 'pokemonCheck' || state.pokemonCheck === null) {
          state.pokemonCheck = createPokemonCheckState(state);
        }
      } else {
        state.pokemonCheck = null;
      }
      state.phase = action.phase;
      return;
    }

    case 'resolvePokemonCheckTarget': {
      const check = state.pokemonCheck;
      const step = check?.steps.find((candidate) => candidate.order === action.order);
      const target = step?.targets.find(
        (candidate) =>
          candidate.playerId === action.playerId &&
          candidate.slotId === action.slotId &&
          candidate.topInstanceId === action.expectedTopInstanceId,
      );
      // 両画面から同時に届いた要求や、古い画面から届いた要求は安全にno-op。
      if (!step || !target || target.resolved) return;

      target.resolved = true;
      if (action.skip) {
        target.skipped = true;
        return;
      }

      const slot = state.players[action.playerId]?.pokemon.find(
        (candidate) => candidate.slotId === action.slotId,
      );
      const currentTop = slot?.stack[slot.stack.length - 1];
      // チェック中に入れ替わった場合は、新しいポケモンへ処理を誤適用しない。
      if (!slot || currentTop !== action.expectedTopInstanceId) {
        target.skipped = true;
        return;
      }

      if (step.condition === 'poisoned') {
        slot.damageCounters += Math.max(0, Math.trunc(action.poisonCounters ?? 1));
        return;
      }
      if (step.condition === 'burned') {
        slot.damageCounters += 2;
        target.coinResult = action.coinResult ?? null;
        if (action.coinResult === 'heads') {
          slot.conditions = slot.conditions.filter((condition) => condition !== 'burned');
        }
        return;
      }
      if (step.condition === 'asleep') {
        target.coinResult = action.coinResult ?? null;
        if (action.coinResult === 'heads') {
          slot.conditions = slot.conditions.filter((condition) => condition !== 'asleep');
        }
        return;
      }
      if (step.condition === 'paralyzed') {
        slot.conditions = slot.conditions.filter((condition) => condition !== 'paralyzed');
      }
      return;
    }

    case 'endTurn': {
      // ★終わる番の情報は、列を動かす前に控えておく（期間切れの判定に使う）
      const finishedTurn = state.turn;
      const finishedPlayer = state.activePlayer;

      const finished = state.turnQueue.shift();
      const finishedMeta = state.turnQueueMeta.shift();
      /*
       * 終わった番のプレイヤーを列の最後に戻して、通常の交互進行を続ける。
       * ★追加の番だったときは戻さない。戻すと、その人の通常の番が1回増えてしまう。
       *   （挿入は insertExtraTurn だけが行い、消費したら消える）
       */
      if (finished !== undefined && !finishedMeta?.isExtra) {
        state.turnQueue.push(finished);
        state.turnQueueMeta.push({ isExtra: false, source: null });
      }

      const nextPlayer = state.turnQueue[0];
      if (nextPlayer === undefined) throw new ActionError('turnQueue が空です');
      state.activePlayer = nextPlayer;
      state.turn += 1;
      // ポケモンチェックを挟んでいた場合も、番が移ったら通常のフェーズに戻す
      if (state.phase === 'pokemonCheck') state.phase = 'turn';
      state.pokemonCheck = null;
      // 番が移ったプレイヤーの1ターン制限を戻すだけ。ルール判定ではなく盤面の初期化
      const player = getPlayer(state, nextPlayer);
      player.turnFlags = {
        energyAttached: false,
        supporterUsed: false,
        stadiumPlayed: false,
        retreated: false,
        // ★ワザの回数もここで戻す（T39）
        attacksUsed: 0,
      };
      // 期間で切れる効果を落とす（T26）。番が移る「あいだ」に1回だけ
      // ★期間切れでカードごと片づけるもの（クレッフィ等。T40）はここでトラッシュへ送る
      for (const cardId of expireByDuration(state, finishedTurn, finishedPlayer)) {
        if (state.cards[cardId]) relocate(state, cardId, discardZoneFor(cardOf(state, ctx, cardId)?.ruleBox));
      }
      /*
       * ★コピーしたワザの参照も番をまたいで残さない（T43）。
       *   イカサマ・アポカリプスドラゴンは「そのワザとして使う」だけなので、
       *   次の番までメニューに残っていると誤操作のもとになる。
       *   手で積んだ参照（grantAttack アクション）も同じ扱いにする。
       */
      for (const slot of getPlayer(state, finishedPlayer).pokemon) slot.grantedAttacks = [];
      recordTurn(state, nextPlayer);
      return;
    }

    case 'detectDefeat': {
      const detection = detectDefeat(
        state,
        action.turnStartDrawFailedPlayerId ?? null,
      );
      if (!detection) return;
      // 同じ条件の再検出では、すでに行われた確認を失わない。
      if (state.gameEnd?.proposalId === detection.proposalId) return;
      state.gameEnd = createGameEndProposal(detection);
      return;
    }

    case 'confirmGameEnd': {
      const proposal = state.gameEnd;
      if (!proposal || proposal.proposalId !== action.proposalId) return;
      if (!(action.playerId in proposal.confirmations)) return;
      proposal.confirmations[action.playerId] = true;
      if (
        Object.keys(state.players).every(
          (playerId) => proposal.confirmations[playerId] === true,
        )
      ) {
        state.phase = 'ended';
      }
      return;
    }

    case 'insertExtraTurn': {
      insertExtraTurnInto(state, action.playerId, action.source ?? null, action.atIndex);
      return;
    }

    case 'setActivePlayer': {
      state.activePlayer = action.playerId;
      return;
    }

    case 'setStadium': {
      /*
       * ★出したスタジアムは stadium ゾーンへ動かす（T33）。
       *   state.stadium を書くだけだと、カードは手札のままなので
       *   **相手にどのスタジアムが出ているのか見えない**。
       *   起動型スタジアム（巨大なカマド等）も「非公開カード」として弾かれてしまう。
       *
       *   外すとき（null）は動かさない。行き先はプレイヤーが moveCard で決める
       *   （トラッシュか、効果によっては手札か山札）。
       *
       * ★順番に注意。relocate は detachEverywhere を通るので、
       *   先に state.stadium を書くと、そこで自分自身を null に戻してしまう。
       */
      if (action.cardId) relocate(state, action.cardId, 'stadium');
      state.stadium = action.cardId;
      return;
    }

    // ── 対戦準備 ──
    case 'setSetupStep': {
      const setup = requireSetup(state);
      setup.step = action.step;
      // 準備の段は自己申告制。段が進んだら申告を戻す
      for (const progress of Object.values(setup.progress)) progress.ready = false;
      if (action.step === 'done') {
        state.setup = null;
        state.phase = 'turn';
        state.turn = 1;
        // 1番目の番が始まる。ここから turnQueue が実際に回りだす（T13）
        if (state.turnHistory.length === 0 && state.activePlayer) {
          recordTurn(state, state.activePlayer);
        }
      }
      return;
    }

    case 'setJankenWinner': {
      requireSetup(state).jankenWinner = action.playerId;
      return;
    }

    case 'setFirstPlayer': {
      const setup = requireSetup(state);
      setup.firstPlayer = action.playerId;
      state.firstPlayer = action.playerId;
      const others = Object.keys(state.players).filter((id) => id !== action.playerId);
      state.turnQueue = [action.playerId, ...others];
      state.turnQueueMeta = state.turnQueue.map(() => ({ isExtra: false, source: null }));
      state.activePlayer = action.playerId;
      return;
    }

    case 'recordMulligan': {
      setupProgress(state, action.playerId).mulligans += 1;
      return;
    }

    case 'declareBonusDraw': {
      setupProgress(state, action.playerId).bonusDraw = Math.max(0, action.count);
      return;
    }

    case 'setSetupReady': {
      setupProgress(state, action.playerId).ready = action.ready;
      return;
    }

    // ── カード効果の実行（T24） ──
    case 'startEffect': {
      const execution = createExecution({
        executionId: action.executionId,
        ops: action.ops,
        source: action.source,
      });
      state.execution = execution.ops.length > 0 ? execution : null;
      /*
       * ★「自分の番に1回」を使ったことを、**カードの実体ごとに** 記録する（T34）。
       *   デデンネGX が2匹いれば、それぞれ1回ずつデデチェンジできる。
       *   値は「使った番の番号」なので、番が変われば自動でまた使えるようになるし、
       *   Undo で番が戻れば使用権も戻る（0に戻す処理をどこにも書かない）。
       */
      const { instanceId, abilityIndex } = action.source;
      if (instanceId && abilityIndex !== undefined) {
        state.abilityUses[abilityUseKey(instanceId, abilityIndex)] = state.turn;
        // ★VSTARパワーの特性（スターポータル等）は対戦中1回・プレイヤー単位（T36）
        const kind = abilityOf(state, instanceId, abilityIndex, ctx)?.oncePerGame;
        if (kind) markOncePerGameUsed(state, action.source.playerId, kind);
      }
      return;
    }

    case 'effectStep': {
      // 取り違え防止。別の実行に対する取りこぼしは黙って捨てる
      if (state.execution?.executionId !== action.executionId) return;
      stepEffectInPlace(state, action.rolls ?? {}, ctx);
      return;
    }

    case 'resolveChoice': {
      resolveChoiceInPlace(state, action.requestId, action.selected, action.rolls ?? {}, ctx);
      return;
    }

    case 'removeEffect': {
      state.effects = state.effects.filter((e) => e.effectId !== action.effectId);
      return;
    }

    case 'cancelEffect': {
      // ★打ち切るときも一時公開は必ず戻す（戻さないと山札が見放題になる）
      restoreTemporaryReveal(state);
      state.execution = null;
      return;
    }

    /*
     * ワザの効果とダメージは自動処理しない（ダメージは T19 が別操作で乗せる）。
     * ★ただし「対戦中1回」の枠だけは、ここで確実に消費する（T36）。
     *   GXワザ / VSTARワザ は **プレイヤー単位** なので、
     *   別のGXポケモンに交代しても戻らない。
     */
    case 'useAttack': {
      const attack = attackOf(state, ctx, action.playerId, action.slotId, action.attackIndex);
      const kind = attack?.oncePerGame;
      if (kind) markOncePerGameUsed(state, action.playerId, kind);

      /*
       * ★追加の番を差し込む（タイムレスGX / スタークロノス。T41）。
       *   ターンの並びは盤面の帳簿なので、ここで面倒を見る。
       *   忘れると取り返しがつかないうえ、間違えたら Undo で戻せる。
       */
      if (attack?.extraTurn) {
        insertExtraTurnInto(state, action.playerId, attack.name);
      }
      /*
       * ★この番に使ったワザの回数を数える（T39）。
       *   上限は Ω連打などで変わるので、ここでは数えるだけ。
       *   「使いすぎ」の判断は rules.ts が警告として出す。
       */
      const player = state.players[action.playerId];
      if (player) player.turnFlags.attacksUsed += 1;
      return;
    }

    // 盤面を変えず、ログにだけ残る操作
    case 'flipCoin':
    case 'randomChoice':
    case 'note':
      return;
  }
}
