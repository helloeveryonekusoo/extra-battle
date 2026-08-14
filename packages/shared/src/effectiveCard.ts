/**
 * BREAK進化の合成（第4段階 T37）。
 *
 * エクストラ固有の変則進化。1進化・2進化ポケモンに **横向きに** 重ねる。
 *
 *   引きつぐ（＝下のカードを見る）: ワザ / 特性 / 弱点 / 抵抗力 / にげる
 *   BREAK側を使う                : タイプ / HP / 名前
 *
 * ★「一番上のカードがそのポケモンのすべて」という前提が、ここだけ崩れる。
 *   だから盤面のあちこちで `stack.at(-1)` を直接読むのをやめ、
 *   このファイルの合成関数を通す。
 *
 * ★特性は **両方** 使える。
 *   進化前とBREAK側の両方が特性を持つなら、同じ番に両方使える。
 *   ただし進化前の「番に1回」をすでに使っていたら、BREAKに進化しても再使用はできない。
 *   これは第3段階（T34）で使用回数を **CardInstance 単位** にしてあるので、
 *   何もしなくても成立する（進化前カードの実体はスタックに残ったままなので）。
 */
import { parseEffectSlotKey } from './effects';
import { isVUnionCard } from './vUnion';
import type { RuleContext } from './rules';
import type {
  Ability,
  Attack,
  CardText,
  EnergyType,
  GameState,
  PlayerId,
  SlotId,
} from './types';

/** そのカードがBREAKか。実カードは stage と ruleBox の両方を持つが、片方でも認める */
export const isBreakCard = (card: CardText | undefined): boolean =>
  card?.stage === 'break' || card?.ruleBox === 'BREAK';

/** 進化スタックを下から順に。正体が見えないカードは undefined のまま残す */
export interface StackEntry {
  instanceId: string;
  card: CardText | undefined;
}

export function stackEntriesOf(
  state: GameState,
  playerId: PlayerId,
  slotId: SlotId,
  ctx: RuleContext = {},
): StackEntry[] {
  const slot = state.players[playerId]?.pokemon.find((entry) => entry.slotId === slotId);
  return (slot?.stack ?? []).map((instanceId) => {
    const instance = state.cards[instanceId];
    const card =
      instance && instance.functionalId !== ''
        ? ctx.cards?.byFunctionalId.get(instance.functionalId)
        : undefined;
    return { instanceId, card };
  });
}

/**
 * そのポケモンの「合成された姿」。
 *
 * top  … タイプ・HP・名前の出どころ（一番上のカード）
 * base … ワザ・弱点・抵抗力・にげるの出どころ。
 *        BREAKでなければ top と同じカードになる。
 */
export interface EffectiveProfile {
  top: StackEntry | undefined;
  base: StackEntry | undefined;
  /** BREAK進化しているか（top と base が違うか） */
  isBreak: boolean;
  /** V-UNION（4枚で1匹）として組み上がっているか（T38） */
  isVUnion: boolean;
  attacks: { attack: Attack; from: StackEntry; index: number }[];
  abilities: { ability: Ability; from: StackEntry; index: number }[];
  weakness: CardText['weakness'];
  resistance: CardText['resistance'];
  retreatCost: number;
  types: EnergyType[];
  hp: number | undefined;
}

/**
 * スタックを走査して、実際に使えるワザ・特性などを合成する。
 *
 * ★どのカード由来かを一緒に返す（§4.3 の詳細パネル用）。
 *   「このワザは下のゾロアークのもの」と画面に出せるようにするため。
 */
export function effectiveProfileOf(
  state: GameState,
  playerId: PlayerId,
  slotId: SlotId,
  ctx: RuleContext = {},
): EffectiveProfile {
  const entries = stackEntriesOf(state, playerId, slotId, ctx);
  const top = entries[entries.length - 1];

  // ★V-UNION は4枚で1匹（T38）。進化ではないので、別の合成をする
  if (entries.length > 1 && entries.every(({ card }) => isVUnionCard(card))) {
    return assembledVUnionProfile(entries);
  }

  // 一番上から下へ、BREAKでないカードに当たるまで降りる
  let baseIndex = entries.length - 1;
  while (baseIndex > 0 && isBreakCard(entries[baseIndex]?.card)) baseIndex -= 1;
  const base = entries[baseIndex];

  const isBreak = Boolean(top && base && top.instanceId !== base.instanceId);

  const attacks = (base?.card?.attacks ?? []).map((attack, index) => ({
    attack,
    from: base as StackEntry,
    index,
  }));

  /*
   * ★特性は下とBREAK側の両方。
   *   使用回数は CardInstance 単位（T34）なので、
   *   どちらの特性かで from が変わり、そのまま別々に数えられる。
   */
  const abilities = [
    ...(base?.card?.abilities ?? []).map((ability, index) => ({
      ability,
      from: base as StackEntry,
      index,
    })),
    ...(isBreak
      ? (top?.card?.abilities ?? []).map((ability, index) => ({
          ability,
          from: top as StackEntry,
          index,
        }))
      : []),
  ];

  return {
    top,
    base,
    isBreak,
    isVUnion: false,
    attacks,
    abilities,
    // ★引きつぐもの
    weakness: base?.card?.weakness ?? null,
    resistance: base?.card?.resistance ?? null,
    retreatCost: base?.card?.retreatCost ?? 0,
    // ★BREAK側を使うもの
    types: top?.card?.types ?? [],
    hp: top?.card?.hp,
  };
}

/**
 * ★V-UNION の合成（T38）。
 *
 * 4枚は上下関係ではなく **並列**。だから「下から引きつぐ」ではなく、
 * 4枚ぶんを全部足し合わせる:
 *
 *   ワザ・特性 … 4枚ぶんを番号順につなげる
 *   HP        … 組み上がった1匹ぶん（各カードに同じ値が入るので最大値を採る）
 *   弱点など   … 印刷されている1枚から採る（最初に見つかったもの）
 */
function assembledVUnionProfile(entries: readonly StackEntry[]): EffectiveProfile {
  const ordered = [...entries].sort(
    (a, b) => (a.card?.vUnionPart ?? 0) - (b.card?.vUnionPart ?? 0),
  );
  const first = ordered[0];

  const attacks = ordered.flatMap((entry) =>
    (entry.card?.attacks ?? []).map((attack, index) => ({ attack, from: entry, index })),
  );
  const abilities = ordered.flatMap((entry) =>
    (entry.card?.abilities ?? []).map((ability, index) => ({ ability, from: entry, index })),
  );

  const firstDefined = <T,>(pick: (card: CardText) => T | null | undefined): T | null => {
    for (const entry of ordered) {
      if (!entry.card) continue;
      const value = pick(entry.card);
      if (value !== null && value !== undefined) return value;
    }
    return null;
  };

  return {
    top: entries[entries.length - 1],
    base: first,
    // 進化ではないので isBreak は立てない。§4.3 の横向き表示もしない
    isBreak: false,
    isVUnion: true,
    attacks,
    abilities,
    weakness: firstDefined((card) => card.weakness),
    resistance: firstDefined((card) => card.resistance),
    retreatCost: firstDefined((card) => card.retreatCost) ?? 0,
    types: [...new Set(ordered.flatMap((entry) => entry.card?.types ?? []))],
    hp: Math.max(0, ...ordered.map((entry) => entry.card?.hp ?? 0)) || undefined,
  };
}

// ── 指示書 §T37 が名指しした3つ ────────────

const bySlotKey = <T,>(
  state: GameState,
  slotKey: string,
  ctx: RuleContext,
  pick: (profile: EffectiveProfile) => T,
  fallback: T,
): T => {
  const parsed = parseEffectSlotKey(slotKey);
  if (!parsed) return fallback;
  return pick(effectiveProfileOf(state, parsed.playerId, parsed.slotId, ctx));
};

/** 実際に使えるワザ。BREAKなら進化前のもの */
export function getEffectiveAttacks(
  state: GameState,
  slotKey: string,
  ctx: RuleContext = {},
): Attack[] {
  return bySlotKey(state, slotKey, ctx, (p) => p.attacks.map((entry) => entry.attack), []);
}

/** 実際の弱点。BREAKなら進化前のもの */
export function getEffectiveWeakness(
  state: GameState,
  slotKey: string,
  ctx: RuleContext = {},
): CardText['weakness'] {
  return bySlotKey(state, slotKey, ctx, (p) => p.weakness, null);
}

/** 実際の抵抗力。BREAKなら進化前のもの */
export function getEffectiveResistance(
  state: GameState,
  slotKey: string,
  ctx: RuleContext = {},
): CardText['resistance'] {
  return bySlotKey(state, slotKey, ctx, (p) => p.resistance, null);
}

/**
 * 実際のにげるためのエネルギー。BREAKなら進化前のもの。
 * ★どうぐ等の増減は derived.ts の getRetreatCost が、この値を土台にして足し引きする。
 */
export function getEffectiveRetreatCost(
  state: GameState,
  slotKey: string,
  ctx: RuleContext = {},
): number {
  return bySlotKey(state, slotKey, ctx, (p) => p.retreatCost, 0);
}

/** 実際のタイプ。★BREAK側を使う */
export function getEffectiveTypes(
  state: GameState,
  slotKey: string,
  ctx: RuleContext = {},
): EnergyType[] {
  return bySlotKey(state, slotKey, ctx, (p) => p.types, []);
}

/** 実際の最大HP。★BREAK側を使う */
export function getEffectiveHp(
  state: GameState,
  slotKey: string,
  ctx: RuleContext = {},
): number | undefined {
  return bySlotKey(state, slotKey, ctx, (p) => p.hp, undefined);
}
