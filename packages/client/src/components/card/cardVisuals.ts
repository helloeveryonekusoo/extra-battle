/**
 * カードの見た目に関する語彙。
 *
 * 絶対制約: 画像・公式ロゴ・公式のエネルギー記号は一切使わない（§2）。
 * タイプは色、記号は自作の円、それ以外はすべてタイポグラフィで表現する。
 */
import type { CardText, EnergyType, RuleBox, Stage, TrainerKind } from '@pokeca/shared';

export const TYPE_COLOR: Record<EnergyType, string> = {
  grass: 'var(--grass)',
  fire: 'var(--fire)',
  water: 'var(--water)',
  lightning: 'var(--lightning)',
  psychic: 'var(--psychic)',
  fighting: 'var(--fighting)',
  darkness: 'var(--darkness)',
  metal: 'var(--metal)',
  fairy: 'var(--fairy)',
  dragon: 'var(--dragon)',
  colorless: 'var(--colorless)',
};

export const TYPE_LABEL: Record<EnergyType, string> = {
  grass: '草',
  fire: '炎',
  water: '水',
  lightning: '雷',
  psychic: '超',
  fighting: '闘',
  darkness: '悪',
  metal: '鋼',
  fairy: 'フェアリー',
  dragon: 'ドラゴン',
  colorless: '無色',
};

export const STAGE_LABEL: Record<Stage, string> = {
  basic: 'たね',
  stage1: '1進化',
  stage2: '2進化',
  mega: 'M進化',
  break: 'BREAK進化',
  vmax: 'VMAX',
  vstar: 'VSTAR',
  vunion: 'V-UNION',
  restored: '復元',
};

export const TRAINER_LABEL: Record<TrainerKind, string> = {
  item: 'グッズ',
  tool: 'ポケモンのどうぐ',
  supporter: 'サポート',
  stadium: 'スタジアム',
};

export const ABILITY_LABEL = {
  ability: '特性',
  ancientTrait: '古代能力',
  pokeBody: 'ポケボディー',
  pokePower: 'ポケパワー',
} as const;

/** ルールボックスのバッジ表記。null は非ルールなのでバッジを出さない */
export const RULE_BOX_LABEL: Record<NonNullable<RuleBox>, string> = {
  EX: 'ex',
  MEGA: 'M',
  BREAK: 'BREAK',
  GX: 'GX',
  PRISM: '◇',
  TAGTEAM: 'TAG TEAM',
  V: 'V',
  VMAX: 'VMAX',
  VUNION: 'V-UNION',
  VSTAR: 'VSTAR',
  RADIANT: 'かがやく',
  ex: 'ex',
};

/** トレーナーズ・特殊エネルギーの帯に使う中立色 */
export const NEUTRAL_STRIPE = 'var(--trainer)';

/**
 * カード左端の帯。デュアルタイプは上下2色に割る。
 * 一瞥してタイプが分かることが目的なので、混色にはしない。
 */
export function stripeBackground(card: CardText): string {
  const types = card.types ?? card.energyProvides ?? [];
  const colors = types.map((t) => TYPE_COLOR[t]);
  if (colors.length === 0) return NEUTRAL_STRIPE;
  if (colors.length === 1) return colors[0]!;
  const step = 100 / colors.length;
  const stops = colors.map((c, i) => `${c} ${i * step}% ${(i + 1) * step}%`);
  return `linear-gradient(180deg, ${stops.join(', ')})`;
}

/** カードの「見出しに出す一言」。1進化 ← コダック / グッズ / 基本エネルギー など */
export function cardKindLine(card: CardText): string {
  if (card.supertype === 'pokemon') {
    const stage = card.stage ? STAGE_LABEL[card.stage] : '';
    return card.evolvesFrom ? `${stage} ← ${card.evolvesFrom}` : stage;
  }
  if (card.supertype === 'trainer') {
    return card.trainerKind ? TRAINER_LABEL[card.trainerKind] : 'トレーナーズ';
  }
  return card.isBasicEnergy ? '基本エネルギー' : '特殊エネルギー';
}

/** HPバーの色。残量で緑→黄→赤 */
export function hpColor(remaining: number, max: number): string {
  if (max <= 0) return 'var(--hp-high)';
  const ratio = remaining / max;
  if (ratio > 0.5) return 'var(--hp-high)';
  if (ratio > 0.2) return 'var(--hp-mid)';
  return 'var(--hp-low)';
}
