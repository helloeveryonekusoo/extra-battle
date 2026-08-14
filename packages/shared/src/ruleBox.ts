/**
 * ルールボックスのクラス固有ルール（第4段階 §3 / T36）。
 *
 * ★クラスごとの決まりを **1つの表** に集める。
 *   サイド枚数・きぜつしたカードの行き先・番が終わるか、を散らばらせない。
 *   カードが増えても、判定コードではなくこの表だけを見ればよい状態にする。
 *
 * ★ここは「既定はこうなる」を答えるだけ。止めることも、勝手に処理することもしない。
 *   実際の枚数は人が変えられる（第2段階の原則）。
 */
import type { OncePerGameKind, PlayerId, RuleBox, GameState, Zone } from './types';

export interface RuleBoxRule {
  /** 画面に出す名前 */
  label: string;
  /** きぜつさせた側がとるサイドの既定枚数 */
  prizes: number;
  /**
   * きぜつ・使用したあとの行き先。
   * ★プリズムスターだけトラッシュではなく **ロストゾーン**。
   */
  goesTo: Zone;
  /** ★M進化すると自分の番が終わる */
  endsTurnOnEvolve: boolean;
  /** デッキに入れられる枚数の上限（同名で数える）。null なら通常の4枚 */
  deckLimit: number | null;
}

const DEFAULT_RULE: RuleBoxRule = {
  label: '—',
  prizes: 1,
  goesTo: 'discard',
  endsTurnOnEvolve: false,
  deckLimit: null,
};

/**
 * ★第4段階 §3 の表そのもの。
 *   BREAK・プリズムスター・かがやくは「ルールを持つがサイドは増えない」。
 */
export const RULE_BOX_RULES: Record<NonNullable<RuleBox>, RuleBoxRule> = {
  EX: { ...DEFAULT_RULE, label: 'ポケモンEX', prizes: 2 },
  MEGA: { ...DEFAULT_RULE, label: 'M進化', prizes: 2, endsTurnOnEvolve: true },
  BREAK: { ...DEFAULT_RULE, label: 'BREAK', prizes: 1 },
  GX: { ...DEFAULT_RULE, label: 'ポケモンGX', prizes: 2 },
  PRISM: { ...DEFAULT_RULE, label: 'プリズムスター', prizes: 1, goesTo: 'lost', deckLimit: 1 },
  TAGTEAM: { ...DEFAULT_RULE, label: 'TAG TEAM', prizes: 3 },
  V: { ...DEFAULT_RULE, label: 'ポケモンV', prizes: 2 },
  VMAX: { ...DEFAULT_RULE, label: 'ポケモンVMAX', prizes: 3 },
  VUNION: { ...DEFAULT_RULE, label: 'ポケモンV-UNION', prizes: 3 },
  VSTAR: { ...DEFAULT_RULE, label: 'ポケモンVSTAR', prizes: 2 },
  RADIANT: { ...DEFAULT_RULE, label: 'かがやくポケモン', prizes: 1, deckLimit: 1 },
  ex: { ...DEFAULT_RULE, label: 'ポケモンex', prizes: 2 },
};

export const ruleFor = (ruleBox: RuleBox | undefined): RuleBoxRule =>
  ruleBox ? (RULE_BOX_RULES[ruleBox] ?? DEFAULT_RULE) : DEFAULT_RULE;

/**
 * そのカードが場を離れるときの行き先。
 * ★プリズムスターはトラッシュではなくロストゾーンへ（T36）。
 */
export const discardZoneFor = (ruleBox: RuleBox | undefined): Zone => ruleFor(ruleBox).goesTo;

// ── ★対戦中1回（プレイヤー単位） ──────────

export const ONCE_PER_GAME_LABEL: Record<OncePerGameKind, string> = {
  gx: 'GXワザ',
  vstar: 'VSTARパワー',
  // ★V-UNION の組み立ても「対戦中1回・プレイヤー単位」（T38）
  vunion: 'V-UNIONの組み立て',
};

/** その枠をこの対戦でもう使ったか。★ポケモンではなくプレイヤーで数える */
export function hasUsedOncePerGame(
  state: GameState,
  playerId: PlayerId,
  kind: OncePerGameKind,
): boolean {
  return state.players[playerId]?.oncePerGameUsed.includes(kind) ?? false;
}

/** 使ったことを記録する。すでにあれば何もしない（state を直接書き換える） */
export function markOncePerGameUsed(
  state: GameState,
  playerId: PlayerId,
  kind: OncePerGameKind,
): void {
  const player = state.players[playerId];
  if (!player || player.oncePerGameUsed.includes(kind)) return;
  player.oncePerGameUsed = [...player.oncePerGameUsed, kind];
}
