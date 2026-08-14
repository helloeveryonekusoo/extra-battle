/**
 * カードの見た目に関する語彙。
 *
 * 絶対制約: 画像・公式ロゴ・公式のエネルギー記号は一切使わない（§2）。
 * タイプは色、記号は自作の円、それ以外はすべてタイポグラフィで表現する。
 */
import { ENERGY_TYPES, type CardText, type EnergyType, type RuleBox, type Stage, type TrainerKind } from '@pokeca/shared';

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

/**
 * カードの枠の色。実物のカードが枠の色で種類を見分けさせているのに倣う。
 * ★色だけ。公式の枠画像・ロゴ・書体は使わない（絶対制約1・5）。
 */
export const TRAINER_FRAME: Record<TrainerKind, string> = {
  item: 'var(--water)',
  tool: 'var(--metal)',
  supporter: 'var(--fire)',
  stadium: 'var(--grass)',
};

export function frameColor(card: CardText): string {
  if (card.supertype === 'trainer') {
    return card.trainerKind ? TRAINER_FRAME[card.trainerKind] : NEUTRAL_STRIPE;
  }
  const types = card.types ?? card.energyProvides ?? [];
  return types[0] ? TYPE_COLOR[types[0]] : NEUTRAL_STRIPE;
}

/**
 * 実物のカードの下端に必ず刷ってある決まり文句。
 * ★カードごとの文ではなく **ゲームのルールそのもの** なので、カードデータには持たせない。
 */
export const TRAINER_RULE_TEXT: Record<TrainerKind, string> = {
  item: 'グッズは自分の番に何枚でも使える。',
  tool: 'ポケモンのどうぐは、1匹に1枚しかつけられない。',
  supporter: 'サポートは自分の番に1枚しか使えない。',
  stadium:
    'このカードは場に出したままにする。別のスタジアムが出たらトラッシュする。同じ名前のスタジアムが出ているなら、このカードは出せない。',
};

// ── 並び順 ──────────────────────────

export const CARD_GROUPS = [
  ['pokemon', 'ポケモン'],
  ['item', 'グッズ'],
  ['tool', 'ポケモンのどうぐ'],
  ['supporter', 'サポート'],
  ['stadium', 'スタジアム'],
  ['energy', 'エネルギー'],
] as const;

export type CardGroup = (typeof CARD_GROUPS)[number][0];

export function groupOfCard(card: CardText): CardGroup {
  if (card.supertype === 'pokemon') return 'pokemon';
  if (card.supertype === 'energy') return 'energy';
  return card.trainerKind ?? 'item';
}

/** 進化段階の並び。たねが先、そこから進化していく順 */
const STAGE_ORDER: Record<Stage, number> = {
  basic: 0,
  restored: 0,
  stage1: 1,
  stage2: 2,
  mega: 3,
  vmax: 3,
  vstar: 3,
  vunion: 3,
  break: 4,
};

/**
 * カタログの並び替え（T51）。
 *
 * ★ポケモンは **進化ラインでまとめる** のが目的。
 *   名前順だと「メッソン」と「インテレオン」が離れ、デッキを組むときに行き来することになる。
 *   タイプ → 進化ラインの根 → 進化段階 → 名前 の順に並べる。
 */
export function sortForCatalog(cards: readonly CardText[]): CardText[] {
  const byName = new Map<string, CardText>();
  for (const card of cards) if (!byName.has(card.name)) byName.set(card.name, card);

  /** 進化前をたどって、そのラインの一番下（たね）の名前を返す */
  const rootOf = (card: CardText): string => {
    let current = card;
    const seen = new Set<string>();
    while (current.evolvesFrom && !seen.has(current.name)) {
      seen.add(current.name);
      const previous = byName.get(current.evolvesFrom);
      if (!previous) return current.evolvesFrom;
      current = previous;
    }
    return current.name;
  };

  const groupIndex = new Map(CARD_GROUPS.map(([key], i) => [key, i]));
  const typeIndex = (card: CardText): number => {
    const type = (card.types ?? card.energyProvides ?? [])[0];
    return type ? ENERGY_TYPES.indexOf(type) : ENERGY_TYPES.length;
  };
  const ja = (a: string, b: string): number => a.localeCompare(b, 'ja');

  return [...cards].sort((a, b) => {
    const group = (groupIndex.get(groupOfCard(a)) ?? 0) - (groupIndex.get(groupOfCard(b)) ?? 0);
    if (group !== 0) return group;

    if (a.supertype === 'pokemon' && b.supertype === 'pokemon') {
      const type = typeIndex(a) - typeIndex(b);
      if (type !== 0) return type;
      const line = ja(rootOf(a), rootOf(b));
      if (line !== 0) return line;
      const stage =
        (a.stage ? STAGE_ORDER[a.stage] : 0) - (b.stage ? STAGE_ORDER[b.stage] : 0);
      if (stage !== 0) return stage;
    }

    if (a.supertype === 'energy' && b.supertype === 'energy') {
      const basic = Number(Boolean(b.isBasicEnergy)) - Number(Boolean(a.isBasicEnergy));
      if (basic !== 0) return basic;
    }

    return ja(a.name, b.name);
  });
}

/** HPバーの色。残量で緑→黄→赤 */
export function hpColor(remaining: number, max: number): string {
  if (max <= 0) return 'var(--hp-high)';
  const ratio = remaining / max;
  if (ratio > 0.5) return 'var(--hp-high)';
  if (ratio > 0.2) return 'var(--hp-mid)';
  return 'var(--hp-low)';
}
