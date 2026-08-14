/**
 * ポケカ エクストラ 対戦卓 — 共有データモデル（§5）
 *
 * 方針:
 * - このファイルは「盤面を表現する」ためだけの型を持つ。ルール判定の型は持たない。
 * - 可視性はゾーンではなく **カード単位**（§4.3）。CardInstance.visibleTo / faceUp が唯一の真実。
 * - 「可変にすべき値」を定数にしない（§5.1）。ベンチ上限・サイド枚数・ターン順はすべてデータ。
 */
// actions.ts とは型のみの相互参照。verbatimModuleSyntax により実行時の循環は起きない。
import type { Action } from './actions';
import type { ActiveEffect, CardFilter, EffectExecution, Op } from './dsl';
import type { RuleWarning } from './rules';

// ── 基本 ──────────────────────────────

/** プレイヤー識別子。GameState.players のキーになるため string ベース。 */
export type PlayerId = string;

/** サーバー自身が行った操作（シャッフル・コイン等）のログ主体 */
export const SERVER_ACTOR = 'server' as const;
export type Actor = PlayerId | typeof SERVER_ACTOR;

export type EnergyType =
  | 'grass'
  | 'fire'
  | 'water'
  | 'lightning'
  | 'psychic'
  | 'fighting'
  | 'darkness'
  | 'metal'
  | 'fairy'
  | 'dragon'
  | 'colorless';

export type Stage =
  | 'basic'
  | 'stage1'
  | 'stage2'
  | 'mega'
  | 'break'
  | 'vmax'
  | 'vstar'
  | 'vunion'
  | 'restored';

/** ルールを持つポケモン。null = 非ルール */
export type RuleBox =
  | null
  | 'EX'
  | 'MEGA'
  | 'BREAK'
  | 'GX'
  | 'PRISM'
  | 'TAGTEAM'
  | 'V'
  | 'VMAX'
  | 'VUNION'
  | 'VSTAR'
  | 'RADIANT'
  | 'ex';

export type Zone =
  | 'deck'
  | 'hand'
  | 'active'
  | 'bench'
  | 'prize'
  | 'discard'
  | 'lost'
  | 'stadium';

export type SpecialCondition = 'poisoned' | 'burned' | 'asleep' | 'paralyzed' | 'confused';

export type TrainerKind = 'item' | 'tool' | 'supporter' | 'stadium';

/**
 * 場のスロット。'active' と 'bench-0'..'bench-N'。
 * ベンチ上限は可変なので上限を型に埋め込まない（§5.1-1）。
 */
export type SlotId = 'active' | `bench-${number}`;

// ── カード定義（静的） ─────────────────

/**
 * 「対戦中1回」の枠（第4段階 T36）。
 * ★ポケモン単位ではなく **プレイヤー単位**。
 *   別のGXポケモンに交代しても、1回使っていたらもう使えない。
 */
export type OncePerGameKind = 'gx' | 'vstar' | 'vunion';

export interface Attack {
  name: string;
  cost: EnergyType[];
  /** "120" "120+" "60×" "" など原文のまま保持。数値化しない */
  damage: string;
  text: string;
  /** GXワザ / VSTARワザ。指定すると対戦中1回に制限される（T36） */
  oncePerGame?: OncePerGameKind;
  /**
   * ★このワザを使うと、そのプレイヤーの番がもう一度来る（第4段階 T41）。
   *   ディアルガGX（タイムレスGX）/ オリジンディアルガVSTAR（スタークロノス）。
   *   turnQueue に追加の番を差し込む。
   */
  extraTurn?: boolean;
  /**
   * ワザの効果を自動化するオペコード（第4段階 T42）。
   * ★ダメージそのものはここに書かない。人が6段パイプラインで確定させる（§4.1）。
   *   ここに書くのは「次の相手の番、相手はグッズを使えない」のような **付随する効果**。
   *   省略・null は MANUAL（そのワザの効果は手で処理する）。
   */
  effects?: Op[] | null;
}

/**
 * 特性がいつはたらくか（第3段階 T34 / 第4段階 T43）。
 * - `activate`        … 自分から使う（既定）
 * - `onPlayFromHand`  … ★手札から場に出したときに自動ではたらく
 * - `onEvolve`        … ★進化させたときに自動ではたらく（うらこうさく）
 * - `passive`         … 常時型。効果は continuous / locks に書く
 */
export type AbilityTrigger = 'activate' | 'onPlayFromHand' | 'onEvolve' | 'passive';

export interface Ability {
  name: string;
  text: string;
  /** 古代能力は特性と別枠 */
  kind: 'ability' | 'ancientTrait' | 'pokeBody' | 'pokePower';
  /** 省略時は 'activate' */
  trigger?: AbilityTrigger;
  /**
   * ★「自分の番に1回」（T34）。
   *   使用回数は **CardInstance 単位** で数える。
   *   同名のポケモンが2匹いれば、それぞれ1回ずつ使える。
   */
  oncePerTurn?: boolean;
  /**
   * VSTARパワーの特性（スターポータル等）。対戦中1回・**プレイヤー単位**（T36）。
   * ワザ側の VSTARパワーと同じ枠を食い合う。
   */
  oncePerGame?: OncePerGameKind;
  /**
   * ★使うと、その番が終わる特性（ザシアンVのふとうのつるぎ。T43）。
   *   M進化と同じく **勝手に番を終わらせない**。info の警告を出して人に押してもらう（§2）。
   */
  endsTurn?: boolean;
  /** 自動化する効果。null/省略は MANUAL（カード本体の effects とは別枠） */
  effects?: Op[] | null;
}

export interface CardText {
  /** name + 正規化テキストのハッシュ */
  functionalId: string;
  /** デッキ構築の4枚制限はこの文字列の完全一致で判定（§5.1-6） */
  name: string;
  supertype: 'pokemon' | 'trainer' | 'energy';

  // ポケモンのみ
  hp?: number;
  /** デュアルタイプがあるので配列 */
  types?: EnergyType[];
  stage?: Stage;
  evolvesFrom?: string;
  ruleBox?: RuleBox;
  attacks?: Attack[];
  abilities?: Ability[];
  weakness?: { type: EnergyType; modifier: string } | null;
  resistance?: { type: EnergyType; modifier: string } | null;
  retreatCost?: number;

  // トレーナーズのみ
  trainerKind?: TrainerKind;
  isAceSpec?: boolean;

  // エネルギーのみ
  isBasicEnergy?: boolean;
  energyProvides?: EnergyType[];

  /**
   * V-UNION の何番目のカードか（1〜4。第4段階 T38）。
   * ★4枚そろって1匹のポケモンになる。同じ name の4枚が別々の functionalId を持ち、
   *   この番号で並び順が決まる。組み立ては `assembleVUnion` アクション。
   */
  vUnionPart?: number;

  /**
   * 特殊エネルギーが「何個ぶんはたらくか」の宣言（第3段階 T33）。
   *
   * ★固定値にしないこと。
   *   ダブルドラゴンエネルギーは **ドラゴンポケモンについているときだけ** 2個ぶん、
   *   トリプル加速エネルギーは **進化ポケモンのときだけ** 3個ぶん、
   *   ツインエネルギーは **ルールを持つポケモンでは 0個ぶん**（はたらかない）。
   *   つまり「何個ぶんか」はカードの静的な値ではなく、
   *   つけられている相手で決まる **派生状態**。計算は derived.ts が行う。
   *
   * 上から順に見て、最初に当てはまった行を採用する。
   * どれにも当てはまらなければ **0個ぶん**（はたらかない）。
   * 省略した場合は「energyProvides のタイプで1個ぶん」とみなす。
   */
  energyValue?: EnergyValueRule[];

  /**
   * 所属タグ（第3段階 §3.1）。
   * 「ロケット団のポケモン」「リーリエのポケモン」「プラズマ団」「フュージョン」など、
   * 効果が所属で参照するためのラベル。エクストラには該当カードが大量にあるので、
   * ★最初からデータに持たせる。あとから足すと全面改修になる。
   */
  tags?: string[];

  /**
   * 場に出ているあいだ、ずっとはたらく効果の宣言（第3段階 §2.2 / T27）。
   * ★状態には書き込まない。派生状態レイヤ（derived.ts）が毎回ここを読みに来る。
   */
  continuous?: ContinuousEffect[];

  /**
   * ★ロック効果の統一表現（第4段階 §2.2 / T42）。
   *   カードごとに個別のコードを書かない。ここに宣言を1つ足すだけで動く。
   *   判定は lock.ts が1か所で行う。
   */
  locks?: LockEffect[];

  /** 自動化する効果。null/旧データの省略は MANUAL（T30）。ローダーは省略を null に正規化する。 */
  effects?: Op[] | null;

  text?: string;
}

/**
 * 常時型の効果が及ぶ範囲（第3段階 §2.2 / T27）。カードを出している側から見た向き。
 */
export type ContinuousScope = 'all' | 'self' | 'opponent';

/**
 * カードが「場に出ているあいだ、ずっと」出す効果の宣言。
 *
 * ★これは **状態ではなく、カードの静的な定義**。
 *   場から離れれば宣言も消えるので、解除処理を書く必要がない（§2.2）。
 *   ActiveEffect（一度かかったら残る効果）と混同しないこと。
 *
 * ロック系カードそのものの実装は第4段階（§6）。ここは受け皿だけ。
 */
export type ContinuousEffect =
  /** 特性を止める（ダストオキシン / 頂への雪道 / サイレントラボ） */
  | { kind: 'lockAbilities'; scope: ContinuousScope; filter?: CardFilter }
  /** カード種別を使えなくする（グッズロック等） */
  | { kind: 'lockCardKind'; scope: ContinuousScope; trainerKind: TrainerKind[] }
  /** ベンチ上限を変える（スカイフィールド8 / ウソッキー4 / ムゲンゾーン8） */
  | { kind: 'benchLimit'; scope: ContinuousScope; limit: number }
  /** きぜつ時にとられるサイドを増やす */
  | { kind: 'extraPrize'; scope: ContinuousScope; delta: number }
  /**
   * ついているポケモンのどうぐの効果をなくす（ダストダスのダストオキシン。T34）。
   * ★どうぐそのものは外れない。常時効果だけが消える。
   */
  | { kind: 'nullifyTools'; scope: ContinuousScope }
  /**
   * ダメージを増減する（ちからのハチマキ / こだわりハチマキ / ダブルターボエネルギー）。
   * ★T26 の ActiveEffect と違い、これは **状態に残らない**。
   *   どうぐを外せば次の計算から消える（§2.2）。
   */
  | {
      kind: 'damageModifier';
      scope: ContinuousScope;
      /** 与える側なら step2、受ける側なら step5（§4.1 の6段） */
      applyAt: 'step2' | 'step5';
      delta: number;
      /** 'attached' = このカードをつけているポケモンだけ。'all' = scope の範囲すべて */
      on: 'attached' | 'all';
      /** さらに絞る。ちからのハチマキは「バトル場にいるなら」 */
      where?: 'active' | 'bench';
      /** 効かせる側のポケモンへの条件。ストロングエネルギーの「闘ポケモンなら」 */
      selfFilter?: CardFilter;
      /** 相手（受ける側）への条件。こだわりハチマキの「V・GX・ex に対して」 */
      defenderFilter?: CardFilter;
      /** 画面とログにそのまま出す説明。「ワザのダメージ +20」など */
      label: string;
    }
  /** にげるためのエネルギーを増減する（ふうせん / かるいし） */
  | {
      kind: 'retreatCost';
      scope: ContinuousScope;
      delta: number;
      on: 'attached' | 'all';
    }
  /** 弱点を計算しない（ウィークガードエネルギー） */
  | {
      kind: 'ignoreWeakness';
      scope: ContinuousScope;
      on: 'attached' | 'all';
      selfFilter?: CardFilter;
    }
  /**
   * 特殊エネルギーのはたらきを消す（シンオウ神殿）。
   * ★消えるのは「特別なはたらき」だけで、無色1個ぶんとしては残る。
   */
  | { kind: 'nullifySpecialEnergy'; scope: ContinuousScope }
  /**
   * ★相手の効果を受けない（T39 → T44 で発生源を選べるようにした）。
   *
   *   Ωバリア / Θストップ（古代能力）    … from: ['trainer']
   *   フュージョンエネルギー              … from: ['ability']
   *
   * ★「どの発生源から守るか」を1つの軸にしてある。
   *   カードごとに別の kind を作らない。
   *
   * ★古代能力は特性とは別枠なので、特性ロックでは止まらない。
   *   continuous の宣言は abilities とは別に集めているので、構造的にそうなる。
   */
  | {
      kind: 'effectImmunity';
      scope: ContinuousScope;
      on: 'attached' | 'all';
      selfFilter?: CardFilter;
      /** 守る相手。トレーナーズ / 特性 / ワザ */
      from: ('trainer' | 'ability' | 'attack')[];
    }
  /**
   * この番に使えるワザの回数を増やす（Ω連打。T39）。
   * ★ターン構造に影響する。「1番に1回」を定数で持たないための逃げ道。
   */
  | {
      kind: 'extraAttack';
      scope: ContinuousScope;
      on: 'attached' | 'all';
      /** 増える回数。Ω連打なら +1（＝合計2回） */
      count: number;
    };

// ── ★ロック効果の統一表現（第4段階 §2.2 / T42） ──

/**
 * 止める対象の種類。
 *
 *   abilityLock           特性がなくなる（ソーナンス / ガラルマタドガス / 頂への雪道）。
 *                         ★どうぐを対象にすればダストオキシンも同じ形で書ける。
 *   cardKindLock          そのカード種別を使えない（ラフレシア / オーロット / ムーランド）
 *   attackLock            ワザを使えない（メガニウム）。★宣言そのものができないので
 *                         「この効果は貫通する」ワザも通らない
 *   attackDamageImmunity  ワザのダメージを受けない（ジュナイパー）
 *   benchLimit            ベンチ上限を変える（スカイフィールド / ウソッキー / ムゲンダイナVMAX）
 */
export type LockKind =
  | 'abilityLock'
  | 'cardKindLock'
  | 'attackLock'
  | 'attackDamageImmunity'
  | 'benchLimit';

/**
 * ロックが及ぶ場所（T43 の実物照合で必要になった軸）。
 *
 * ★「おたがいの **場・手札・トラッシュ** にあるポケモンの特性はなくなる」という
 *   書き方の card が実在する（ソーナンス / サイレントラボ / アローラベトベトン）。
 *   省略時は `['field']`＝場のみ。
 */
export type LockZone = 'field' | 'hand' | 'discard';

/**
 * 誰の・どのカードに効くか。
 * `player` は **宣言したカードを出している側から見た向き**。
 * `filter` は影響を受ける側のカードへの条件。空オブジェクト `{}` なら全部。
 */
export interface LockScope {
  player: 'self' | 'opponent' | 'both';
  filter: CardFilter;
  /** 及ぶ場所。省略は場のみ */
  zones?: LockZone[];
}

/**
 * ★ロック効果の統一表現（第4段階 §2.2）。
 *
 *   ★カードの種類ごとに個別実装しない。全部この1つの形で表す。
 *     ダストダス           exceptSelf: false（自分のどうぐも止まる）
 *     ガラルマタドガス     exceptSelf: true, requiresActive: true
 *     アローラベトベトン   filter: { stage: ['basic'] }
 *     頂への雪道           filter: { ruleBox: 'any' }
 *     ラフレシア           cardKindLock（グッズ）
 *
 * ★これは **状態ではなくカードの静的な宣言**（continuous と同じ考え方）。
 *   場を離れれば宣言も消えるので、ロックの解除処理を書く必要がない。
 *
 * ★固定点計算をしない（§2.1）。
 *   ロック効果は「素の盤面」から集める。だから **ロック効果自体はロックされない**。
 *   実際には例外の裁定が存在するので、ロックが2つ以上同時に出ているときは
 *   警告を出して該当ポケモンを ASSISTED に落とす（人の判断に委ねる）。
 */
export interface LockEffect {
  kind: LockKind;
  scope: LockScope;
  /** 発生源のカード自身は影響を受けないか（ガラルマタドガス = true） */
  exceptSelf: boolean;
  /** 発生源がバトル場にいるときだけはたらくか（ガラルマタドガス / オーロット = true） */
  requiresActive: boolean;
  /**
   * 種類ごとの付随情報。
   *   cardKindLock  { trainerKind: TrainerKind[] }
   *   benchLimit    { limit: number }
   *   共通          { requiresAllOwnPokemon: CardFilter }
   *                 自分の場のポケモンが全部この条件に合うときだけはたらく
   *                 （ムゲンダイナVMAX の「悪ポケモンだけなら」）
   */
  payload?: Record<string, unknown>;
  /** 画面とログにそのまま出す説明。省略時は kind から組み立てる */
  label?: string;
}

/**
 * 特殊エネルギーが「何個ぶん・どのタイプとして」はたらくかの1行（T33）。
 * 詳しくは CardText.energyValue を参照。
 */
export interface EnergyValueRule {
  /** つけられているポケモン（進化スタックの一番上）への条件 */
  when?: CardFilter;
  /** 支払えるタイプ。'any' は「好きなタイプ」（レインボーエネルギー等） */
  provides: EnergyType[] | 'any';
  /** 何個ぶん */
  amount: number;
  /** 画面に出す説明。「無色2個ぶん」など */
  label?: string;
}

export interface Printing {
  printingId: string;
  functionalId: string;
  /** "S7R" "SV11B" など */
  setCode: string;
  number: string;
  rarity: string;
  /** フォーマット判定用の発売時代。未指定時は setCode の既知プレフィックスから判定する */
  era?: 'pre-BW' | 'BW' | 'XY' | 'SM' | 'S' | 'SV';
  /** ADV/DP期などから流用可能なカード */
  extraLegalReprint?: boolean;
}

/**
 * 同名エイリアス表（§5.1-7）。
 * 印刷上の表記 → 4枚制限を共有する正規化名。
 * 例: { 'ボスの指令（サカキ）': 'ボスの指令', 'ボスの指令（アカギ）': 'ボスの指令' }
 */
export type NameAliasTable = Record<string, string>;

/**
 * 他カードのワザへの動的参照（§5.1-3）。
 * ゾロアークのイカサマ / メタモン / わざマシン / パーフェクション を
 * すべてこの1つの形で表現する。
 * ここでは「参照を保持する」だけで、解決や実行はしない（§8）。
 */
export interface AttackRef {
  /** ワザの定義元カード */
  functionalId: string;
  /** CardText.attacks の添字 */
  attackIndex: number;
  /** 参照元になっている場のカード実体。カード定義から直接引くなら null */
  sourceInstanceId: string | null;
}

// ── 実行時インスタンス ──────────────────

export interface CardInstance {
  instanceId: string;
  functionalId: string;
  ownerId: PlayerId;
  zone: Zone;
  /**
   * 動的に変わる。ゾーンで固定しない（§4.3）。
   * ここに含まれる PlayerId だけが functionalId を知ることができる。
   */
  visibleTo: PlayerId[];
  faceUp: boolean;
  /** 山札内の順序など */
  position?: number;
}

export interface PokemonInPlay {
  slotId: SlotId;
  /** [たね, 1進化, 2進化] 末尾が一番上。CardInstance.instanceId[] */
  stack: string[];
  attachedEnergy: string[];
  /** 1匹1枚。クレッフィのようにポケモンがどうぐ化する場合もここに入る（§5.1-5） */
  attachedTool: string | null;
  /** ×10 がダメージ量 */
  damageCounters: number;
  conditions: SpecialCondition[];
  /** 「出したばかり／進化したばかり」判定用 */
  placedOnTurn: number;
  evolvedOnTurn: number | null;
  devolvedOnTurn: number | null;
  /** 他カードから一時的に使えるようになったワザ（§5.1-3） */
  grantedAttacks: AttackRef[];
  /** 手動運用用の自由メモ */
  notes: string;
}

export interface TurnFlags {
  energyAttached: boolean;
  supporterUsed: boolean;
  stadiumPlayed: boolean;
  retreated: boolean;
  /**
   * この番に使ったワザの回数（第4段階 T39）。
   * ★「1番に1回」を定数にしない。Ω連打で2回使えるので、上限は派生状態で出す。
   */
  attacksUsed: number;
}

/**
 * TurnFlags のうち「使った / まだ」の真偽で持つもの。
 * ★attacksUsed だけは回数なので別扱い（Ω連打で2回使える。T39）。
 */
export type BooleanTurnFlag = 'energyAttached' | 'supporterUsed' | 'stadiumPlayed' | 'retreated';

export interface PlayerState {
  playerId: PlayerId;
  displayName: string;
  pokemon: PokemonInPlay[];
  /** ★定数5にしないこと。スカイフィールド8 / ウソッキー4 / ムゲンゾーン8（§5.1-1） */
  benchLimit: number;
  /** ★可変。ルールボックスで1/2/3、効果でさらに増減する（§5.1-2） */
  prizesRemaining: number;
  /** HUDのサイド円を描くための初期枚数。6固定にしない */
  prizesTotal: number;
  turnFlags: TurnFlags;
  /**
   * この対戦で使い切った「対戦中1回」の枠（第4段階 T36）。
   * ★ポケモン単位ではなく **プレイヤー単位**。
   *   ポケモンを入れ替えても戻らないので、番の切り替えでも消さない。
   */
  oncePerGameUsed: OncePerGameKind[];
}

export interface LogEntry {
  /** 1始まりの連番。Undo の対象指定に使う */
  seq: number;
  /** epoch ミリ秒 */
  at: number;
  actorId: Actor;
  action: Action;
  /** ログパネルに出す1行の日本語要約 */
  summary: string;
  /** 要約を読んでよいプレイヤー。隠匿情報を含む操作は所有者のみ */
  visibleTo: PlayerId[];
  /** 乱数を使った操作の再現用シード（§4.2） */
  seed?: string;
  /** Undo 済みかどうか */
  undone: boolean;
  /**
   * この操作で出たルール警告（第2段階 §2）。
   * ★状態の一部として持つことで、「ログに残る」「相手にも見える」が構造的に保証される。
   */
  warnings: RuleWarning[];
}

// ── 対戦の進行（T13） ──────────────────

export interface TurnRecord {
  turn: number;
  playerId: PlayerId;
  /** 追加ターン効果によって挿入されたか */
  isExtra: boolean;
  /** 'スタークロノス' など。手入力 */
  source?: string;
}

/**
 * turnQueue と1対1で対応する付帯情報。
 * ★turnQueue 自体は §5 のとおり PlayerId[] のまま保つ（多くの箇所が参照するため）。
 *   「その番が追加ターンか」だけをここに並べる。長さは常に turnQueue と一致させること。
 */
export interface TurnQueueMeta {
  isExtra: boolean;
  source: string | null;
}

// ── ポケモンチェック（T17） ──────────────

export interface PokemonCheckTarget {
  slotId: SlotId;
  playerId: PlayerId;
  /** 開始時にスロットの一番上だったカード。途中の入れ替わりを誤処理しないために使う */
  topInstanceId: string;
  /** コインを使わない段、または未実行なら null */
  coinResult?: 'heads' | 'tails' | null;
  resolved: boolean;
  /** 人が効果例外として処理を飛ばした場合 */
  skipped?: boolean;
}

export interface PokemonCheckStep {
  order: 1 | 2 | 3 | 4;
  condition: SpecialCondition;
  targets: PokemonCheckTarget[];
}

export interface PokemonCheckState {
  /** このチェックの直前に番を行っていたプレイヤー。マヒの回復判定に使う */
  endedTurnPlayerId: PlayerId;
  steps: PokemonCheckStep[];
}

// ── 勝敗確認（T18） ───────────────────

/** そのプレイヤーが敗北条件を満たした理由 */
export type DefeatReason = 'opponentPrizes' | 'noPokemon' | 'deckOut';

export interface GameEndProposal {
  /** 条件の組み合わせから作る安定ID。古い確認要求の誤適用を防ぐ */
  proposalId: string;
  outcome: 'winner' | 'draw';
  winnerId: PlayerId | null;
  /** プレイヤーごとの敗北理由。理由がないプレイヤーは空配列 */
  defeats: Record<PlayerId, DefeatReason[]>;
  /** 自動終了はせず、両者が確認したときだけ phase を ended にする */
  confirmations: Record<PlayerId, boolean>;
}

// ── 対戦準備（T10） ───────────────────

/**
 * 対戦準備の進行段階。
 * ★これはルール判定ではなく「次に何をするか」を両者に見せるための道しるべ。
 *   各段階で実際に何をするかはプレイヤーが決める。飛ばすことも戻ることもできる。
 */
export type SetupStep =
  | 'janken' // じゃんけん
  | 'order' // 勝者が先攻・後攻を選ぶ
  | 'draw' // 山札を切って7枚引く
  | 'mulligan' // たね確認とマリガン
  | 'place' // バトル場・ベンチにウラのまま出す
  | 'prizes' // サイドを置く
  | 'reveal' // いっせいにオモテにする
  | 'done';

export interface SetupProgress {
  /** この人がマリガンした回数。相手が宣言できる追加ドローの上限になる */
  mulligans: number;
  /** 相手のマリガンに対して宣言した追加ドロー枚数。null = まだ宣言していない */
  bonusDraw: number | null;
  /** この段階の作業が終わったと自己申告したか */
  ready: boolean;
}

export interface SetupState {
  step: SetupStep;
  /** じゃんけんの勝者。先攻後攻を選ぶ権利を持つ */
  jankenWinner: PlayerId | null;
  firstPlayer: PlayerId | null;
  progress: Record<PlayerId, SetupProgress>;
}

/** Undo 要求（T11）。相手が承認するまで pending */
export interface UndoRequest {
  requestId: string;
  /** 巻き戻す先。この seq 以降を取り消す */
  targetSeq: number;
  requestedBy: PlayerId;
  status: 'pending' | 'approved' | 'rejected';
}

export interface GameState {
  gameId: string;
  turn: number;
  activePlayer: PlayerId;
  phase: 'setup' | 'turn' | 'pokemonCheck' | 'ended';
  players: Record<PlayerId, PlayerState>;
  cards: Record<string, CardInstance>;
  /** 場に出ているスタジアムの CardInstance.instanceId */
  stadium: string | null;
  /** ★ループではなく配列。追加ターン（スタークロノス等）を挿入できる形にする（§5.1-4） */
  turnQueue: PlayerId[];
  /** turnQueue と同じ長さ。各番が追加ターンかどうか（T13） */
  turnQueueMeta: TurnQueueMeta[];
  /** 先攻のプレイヤー。対戦準備で決まる（T13） */
  firstPlayer: PlayerId | null;
  /** 番の履歴（T13） */
  turnHistory: TurnRecord[];
  /** phase が pokemonCheck の間だけ存在する、共有された順次処理の状態 */
  pokemonCheck: PokemonCheckState | null;
  /** 敗北条件を検出した後の、両者確認待ちの結果 */
  gameEnd: GameEndProposal | null;
  /**
   * いまかかっている効果（第3段階 §3.2 / T26）。
   * ★「一度かかったら残る効果」だけを持つ。特性ロックのような常時型は入れない（§2.2）。
   */
  effects: ActiveEffect[];
  /**
   * 実行中のカード効果（第3段階 §2.1 / T24）。null なら何も動いていない。
   * ★状態としてここに持つので、そのまま保存・再接続・リプレイができる。
   *   ジェネレータで実行位置を持たないのはこのため。
   */
  execution: EffectExecution | null;
  /**
   * 「自分の番に1回」を使った記録（第3段階 T34）。
   *
   * ★キーは **CardInstance 単位**（`${instanceId}#${abilityIndex}`）。
   *   同名のポケモンが2匹いれば、それぞれ1回ずつ使える。
   *
   * ★値は「使った番の番号」。0 に戻す処理を書かないので、
   *   Undo でもリプレイでもずれない（番が変われば自動で使えるようになる）。
   */
  abilityUses: Record<string, number>;
  /** 対戦全体の乱数シード。ログの seed と合わせて再現に使う（§4.2） */
  rngSeed: string;
  pendingUndo: UndoRequest | null;
  /** 対戦準備の進行。準備が終わったら null になる（§T10） */
  setup: SetupState | null;
  log: LogEntry[];
}
