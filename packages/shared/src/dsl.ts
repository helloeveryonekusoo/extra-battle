/**
 * 効果DSL（第3段階 §3.1 / T23）。
 *
 * ★このファイルは「効果をデータとして書くための語彙」だけを持つ。
 *   実行（インタプリタ）は T24、選択の解決は T25、効果の保持は T26 が担当する。
 *
 * 設計の要点:
 *
 * 1. **カードで数えず、オペコードで数える。**
 *    エクストラの2万枚を個別実装するのではなく、11種のオペコードの組み合わせで書く。
 *    そのうち search / draw / attachEnergy / discard の4つで汎用トレーナーズのほとんどが書ける。
 *
 * 2. **すべて JSON にできる形にする（§2.1）。**
 *    実行途中の状態をそのまま保存して再接続できるようにするため、
 *    関数・クラス・シンボルを型に持ち込まない。ここにあるのは素のデータだけ。
 *
 * 3. **`manual` を必ず残す（§7-5）。**
 *    効果の一部だけ自動化し、残りを人間に投げられるようにする逃げ道。
 *    これが ASSISTED モードの実体になる。
 */
import type {
  EnergyType,
  PlayerId,
  RuleBox,
  SpecialCondition,
  Stage,
  TrainerKind,
  Zone,
} from './types';

// ── 参照 ────────────────────────────────

/** 効果から見た「誰の」。self は効果を使った側 */
export type PlayerRef = 'self' | 'opponent' | 'both';

/** 場のポケモンの絞り込み。「ダメージがのっているポケモンを選ぶ」等 */
export interface SlotFilter {
  where?: 'active' | 'bench';
  /** 進化スタックの一番上のカードに対する条件 */
  card?: CardFilter;
  hasDamage?: boolean;
  hasEnergy?: boolean;
  hasTool?: boolean;
  hasCondition?: boolean;
}

export type SlotRef =
  | { kind: 'active'; player: PlayerRef }
  | { kind: 'bench'; player: PlayerRef; index?: number }
  /** 効果の発生源自身 */
  | { kind: 'self' }
  | { kind: 'choose'; player: PlayerRef; chooser: PlayerRef; filter?: SlotFilter }
  /** 直前の選択結果 */
  | { kind: 'binding'; name: string };

// ── カードの絞り込み ─────────────────────

export interface CardFilter {
  /** Any one branch may match; the remaining fields are still AND conditions. */
  anyOf?: CardFilter[];
  supertype?: ('pokemon' | 'trainer' | 'energy')[];
  stage?: Stage[];
  types?: EnergyType[];
  /** ★このタイプを1つでも持つなら合わない（ソーナンスの「超ポケモンをのぞく」） */
  typesNot?: EnergyType[];
  /** 'none' = 非ルール、'any' = ルールを持つポケモン全般 */
  ruleBox?: 'any' | 'none' | RuleBox[];
  ruleBoxNot?: RuleBox[];
  nameExact?: string[];
  nameNotExact?: string[];
  nameContains?: string;
  hpMax?: number;
  isBasicEnergy?: boolean;
  energyProvides?: EnergyType[];
  hasAbilities?: boolean;
  trainerKind?: TrainerKind[];
  /**
   * 「ロケット団のポケモン」「リーリエのポケモン」「プラズマ団」「フュージョン」等の所属タグ。
   * ★エクストラには所属で参照するカードが大量にあるので、最初から入れておく。
   *   あとから足すと全面改修になる（§3.1）。
   */
  tag?: string[];
}

// ── 条件（if オペコード用） ─────────────────

export type Compare = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';

/** 数を数える対象 */
export type CountSource =
  | { source: 'zone'; zone: Zone; owner: PlayerRef; filter?: CardFilter }
  | { source: 'prizes'; player: PlayerRef }
  | { source: 'bench'; player: PlayerRef }
  /** ★条件に合う「場のポケモン」の数（ゲノセクトVの「フュージョンのポケモンの数」。T44） */
  | { source: 'inPlay'; player: PlayerRef; filter?: CardFilter }
  | { source: 'damageCounters'; target: SlotRef }
  | { source: 'attachedEnergy'; target: SlotRef }
  /** coinFlip などが bind した結果の個数 */
  | { source: 'binding'; name: string };

/**
 * ★ここは実カードを書きながら育てる（§7-2）。
 *   いま入っているのは T31〜T33 のカードが実際に必要とするものだけ。
 */
export type Condition =
  | { kind: 'coin'; binding: string; face: 'heads' | 'tails'; atLeast?: number }
  | { kind: 'count'; of: CountSource; compare: Compare; value: number }
  | { kind: 'exists'; slot: SlotRef }
  | { kind: 'playersTurn'; player: PlayerRef; compare: Compare; value: number }
  | { kind: 'knockedOutLastOpponentTurn'; player: PlayerRef }
  | { kind: 'option'; binding: string; equals: string }
  | { kind: 'not'; of: Condition }
  | { kind: 'and'; of: Condition[] }
  | { kind: 'or'; of: Condition[] };

// ── エフェクト（§3.2） ────────────────────

export type EffectDuration =
  | { type: 'thisTurn' }
  | { type: 'untilEndOfNextOpponentTurn' }
  | { type: 'untilEndOfNextOwnTurn' }
  | { type: 'whileSourceInPlay' }
  /** オルタージェネシスGX 等 */
  | { type: 'wholeGame' };

/**
 * ★上級プレイヤー用ルールガイドの消滅ルール（§3.2）。
 *   ベンチに戻る / 場を離れる / 進化 / 退化 で、かかっている効果は消える。
 *   （エネルギー・どうぐ・ダメカンは進化で引きつぐので、ここには含まない）
 */
export type ExpiryCondition =
  | 'targetLeavesPlay'
  | 'targetReturnsToBench'
  | 'targetEvolves'
  | 'targetDevolves'
  | 'sourceLeavesPlay';

/** ダメージ計算のどの段で効くか（§2 の6段パイプライン。T28 で実装） */
export type EffectApplyAt = 'step2' | 'step5' | 'none';

export type EffectKind =
  /** 「+30される」「-30される」 */
  | 'damageModifier'
  /** ワザのダメージを受けない */
  | 'preventAttackDamage'
  /** ワザの効果を受けない */
  | 'preventAttackEffect'
  | 'cannotRetreat'
  | 'cannotUseAttack'
  /**
   * ★ワザでかけるカード種別ロック（ガマゲロゲEX の げこげこアタック。T42）。
   *   payload.trainerKind に止める種別を入れる。
   *   場のロック（ラフレシア等）と違い、発生源が場を離れても残るのでこちら側で持つ。
   */
  | 'lockCardKind'
  /** ★この番、ワザを追加で使える（Ω連打。T39）。payload.count が増える回数 */
  | 'extraAttack'
  /**
   * ★一時的にどうぐになっているカード（クレッフィのワンダーロック。T40）。
   *   期間が切れたら payload.instanceId のカードをトラッシュする。
   *   `CardInstance` の役割が動的に変わるので、「いつ外れるか」を効果として持つ。
   */
  | 'temporaryTool'
  | 'extraPrize'
  | 'custom';

/** 効果の発生源。ログ表示と「発生源が場を離れたか」の判定に使う */
export interface EffectSource {
  /** 発生源のカード実体。カード定義から直接なら null */
  instanceId: string | null;
  playerId: PlayerId;
  /** 「オルタージェネシスGX」など。そのまま画面に出す */
  label: string;
  attackIndex?: number;
  abilityIndex?: number;
}

/** 効果のかかり先。ActiveEffect では解決済みの slotId になる */
export type EffectTarget = { slotId: string } | { player: PlayerId } | { global: true };

export interface ActiveEffect {
  effectId: string;
  source: EffectSource;
  target: EffectTarget;
  applyAt: EffectApplyAt;
  kind: EffectKind;
  payload: Record<string, unknown>;
  duration: EffectDuration;
  expiresOn: ExpiryCondition[];
  createdOnTurn: number;
}

/**
 * applyEffect オペコードが持つひな型。
 * effectId / source / createdOnTurn はインタプリタが埋めるので持たない。
 * target はまだ解決されていないので SlotRef のまま持つ。
 */
export interface ActiveEffectTemplate {
  target: { slot: SlotRef } | { player: PlayerRef } | { global: true };
  applyAt: EffectApplyAt;
  kind: EffectKind;
  payload?: Record<string, unknown>;
  duration: EffectDuration;
  expiresOn?: ExpiryCondition[];
  /** 画面に日本語で出す説明（§5.2 の可視化用）。「ダメージ+50」など */
  label?: string;
}

// ── オペコード（§3.1） ────────────────────

/** 枚数。bindings から引くこともある */
export type CountValue = number | { binding: string } | { from: CountSource };

export type Op =
  | {
      op: 'draw';
      player: PlayerRef;
      count: CountValue;
      /**
       * 「手札が▲枚になるように引く」（クロバットV / シェイミEX。T34）。
       * ★指定すると count は無視する。すでに▲枚以上なら1枚も引かない。
       * ★枚数は動かせる（ゲノセクトVは「場のフュージョンの数」。T44）。
       */
      upToHandSize?: CountValue;
    }

  | {
      op: 'search';
      from: Zone;
      owner: PlayerRef;
      filter: CardFilter;
      count: number;
      upTo: boolean;
      dest: Zone;
      destSlot?: SlotRef;
      chooser: PlayerRef;
      reveal: boolean;
      thenShuffle: boolean;
      /** Only inspect this many cards from the top of the source zone. */
      lookAt?: number;
      bind?: string;
    }

  | {
      op: 'attachEnergy';
      from: Zone;
      filter: CardFilter;
      count: number;
      upTo: boolean;
      target: SlotRef;
      distribution: 'free' | 'single';
      lookAt?: number;
      thenShuffle?: boolean;
    }

  | {
      op: 'moveCard';
      from: Zone | 'inPlay' | 'field';
      to: Zone;
      owner: PlayerRef;
      filter?: CardFilter;
      slotFilter?: SlotFilter;
      count: number | 'all';
      chooser: PlayerRef;
      position?: 'top' | 'bottom';
      /** When moving a Pokemon in play, move its full stack and attachments too. */
      includeAttached?: boolean;
      upTo?: boolean;
      bind?: string;
    }

  | {
      op: 'discard';
      from: Zone;
      owner: PlayerRef;
      filter?: CardFilter;
      count: number | 'all';
      chooser: PlayerRef;
      upTo?: boolean;
      optional?: boolean;
      /** 山札の上から何枚だけを対象にするか（キュワワーの「残りをトラッシュ」。T34） */
      lookAt?: number;
      bind?: string;
    }

  | {
      op: 'evolve';
      from: 'deck' | 'hand';
      player: PlayerRef;
      target: SlotRef;
      chooser: PlayerRef;
      filter?: CardFilter;
      skipStage1?: boolean;
      thenShuffle: boolean;
    }

  | { op: 'switch'; side: 'own' | 'opponent'; chooser: PlayerRef; target?: SlotRef }

  | {
      op: 'damageCounter';
      action: 'place' | 'remove' | 'move';
      count: number;
      target: SlotRef;
      from?: SlotRef;
      distribution: 'free' | 'single';
    }

  | { op: 'heal'; target: SlotRef; amount: number | 'all' }

  | { op: 'coinFlip'; count: number | 'untilTails'; bind: string }

  | { op: 'chooseOption'; chooser: PlayerRef; bind: string; options: { id: string; label: string }[] }

  | { op: 'clearEffects'; source: 'attack' | 'all' }

  | {
      op: 'setCondition';
      target: SlotRef;
      condition: SpecialCondition;
      counterOverride?: number;
    }

  | { op: 'applyEffect'; effect: ActiveEffectTemplate }

  /**
   * ★1つの仕組みで4種類を解決する（§3.1）。個別実装しないこと。
   *   ゾロアーク（イカサマ）/ ミュウツー&ミュウGX（パーフェクション）
   *   / レジドラゴVSTAR（わざマシン）/ メタモン（どこでもコピー）
   */
  | {
      op: 'useAttackAs';
      from: 'opponentActive' | 'ownTrash' | 'ownBench' | 'anyInPlay';
      filter?: CardFilter;
      requireEnergy: boolean;
    }

  | { op: 'shuffle'; zone: Zone; owner: PlayerRef }

  | { op: 'if'; cond: Condition; then: Op[]; else?: Op[] }
  | { op: 'repeat'; times: CountValue; body: Op[] }

  /**
   * ★未実装部分の逃げ道（§3.1 / §7-5）。
   *   これを含む効果は ASSISTED として扱い、この一言だけ人間に見せて手で処理してもらう。
   */
  | { op: 'manual'; prompt: string };

export type OpCode = Op['op'];

// ── 選択の解決（§3.3） ────────────────────

export type ChoiceKind = 'selectCards' | 'selectSlot' | 'selectOption' | 'distribute' | 'confirm';

export interface ChoiceRequest {
  requestId: string;
  chooser: PlayerId;
  kind: ChoiceKind;
  prompt: string;
  /** 選択肢。カードの場合は instanceId の配列 */
  candidates: string[];
  min: number;
  max: number;
  /** ダメカン・エネルギーを複数対象に配分する場合の総数 */
  totalToDistribute?: number;
  /**
   * 選択中だけ chooser に公開するカード（山札を見る等）。
   * ★選択が終わったら必ず可視性を戻すこと（§3.3）。
   */
  temporarilyRevealed: string[];
  /** Optional costs can require either zero or the exact cost. */
  allowedCounts?: number[];
  optionLabels?: Record<string, string>;
}

// ── 実行状態（§2.1） ─────────────────────

/**
 * 効果の実行状態。
 *
 * ★ジェネレータを使わない（§2.1）。
 *   ジェネレータの実行位置はシリアライズできないので、第2段階で作った
 *   再接続・永続化（T22）が壊れる。実行位置は cursor という「ただの数」で持つ。
 */
export interface EffectExecution {
  executionId: string;
  /** 展開済みのオペコード列（if / repeat をフラット化してある） */
  ops: Op[];
  /** 次に実行するインデックス */
  cursor: number;
  /** 中間結果。「選んだカード」「コインの結果」などを名前で保持 */
  bindings: Record<string, unknown>;
  /** プレイヤーの応答待ち。null なら実行可能 */
  pendingChoice: ChoiceRequest | null;
  source: EffectSource;
}

// ── 語彙の一覧（JSON Schema と検証が参照する唯一の出どころ） ──

export const PLAYER_REFS = ['self', 'opponent', 'both'] as const satisfies readonly PlayerRef[];

export const OP_CODES = [
  'draw',
  'search',
  'attachEnergy',
  'moveCard',
  'discard',
  'evolve',
  'switch',
  'damageCounter',
  'heal',
  'coinFlip',
  'chooseOption',
  'clearEffects',
  'setCondition',
  'applyEffect',
  'useAttackAs',
  'shuffle',
  'if',
  'repeat',
  'manual',
] as const satisfies readonly OpCode[];

export const ZONES = [
  'deck',
  'hand',
  'active',
  'bench',
  'prize',
  'discard',
  'lost',
  'stadium',
] as const satisfies readonly Zone[];

export const SPECIAL_CONDITIONS = [
  'poisoned',
  'burned',
  'asleep',
  'paralyzed',
  'confused',
] as const satisfies readonly SpecialCondition[];

export const COMPARES = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] as const satisfies readonly Compare[];

export const EFFECT_KINDS = [
  'damageModifier',
  'preventAttackDamage',
  'preventAttackEffect',
  'cannotRetreat',
  'cannotUseAttack',
  'lockCardKind',
  'extraAttack',
  'temporaryTool',
  'extraPrize',
  'custom',
] as const satisfies readonly EffectKind[];

export const EFFECT_APPLY_AT = ['step2', 'step5', 'none'] as const satisfies readonly EffectApplyAt[];

export const EFFECT_DURATION_TYPES = [
  'thisTurn',
  'untilEndOfNextOpponentTurn',
  'untilEndOfNextOwnTurn',
  'whileSourceInPlay',
  'wholeGame',
] as const satisfies readonly EffectDuration['type'][];

export const EXPIRY_CONDITIONS = [
  'targetLeavesPlay',
  'targetReturnsToBench',
  'targetEvolves',
  'targetDevolves',
  'sourceLeavesPlay',
] as const satisfies readonly ExpiryCondition[];

export const SLOT_REF_KINDS = ['active', 'bench', 'self', 'choose', 'binding'] as const satisfies
  readonly SlotRef['kind'][];

export const CONDITION_KINDS = ['coin', 'count', 'exists', 'playersTurn', 'knockedOutLastOpponentTurn', 'option', 'not', 'and', 'or'] as const satisfies
  readonly Condition['kind'][];

export const COUNT_SOURCES = [
  'zone',
  'prizes',
  'bench',
  'inPlay',
  'damageCounters',
  'attachedEnergy',
  'binding',
] as const satisfies readonly CountSource['source'][];

// ── モード（T30 で使う。ここでは判定だけ置く） ──

export type EffectMode = 'AUTO' | 'ASSISTED' | 'MANUAL';

/**
 * その効果定義がどのモードか。
 * - 定義がない（null）        → MANUAL。従来どおり全部手で動かす
 * - manual オペコードを含む   → ASSISTED。自動化できる部分だけ動かす
 * - それ以外                 → AUTO
 */
export function effectModeOf(ops: readonly Op[] | null | undefined): EffectMode {
  if (!ops) return 'MANUAL';
  return containsManual(ops) ? 'ASSISTED' : 'AUTO';
}

function containsManual(ops: readonly Op[]): boolean {
  for (const op of ops) {
    if (op.op === 'manual') return true;
    if (op.op === 'if' && (containsManual(op.then) || containsManual(op.else ?? []))) return true;
    if (op.op === 'repeat' && containsManual(op.body)) return true;
  }
  return false;
}
