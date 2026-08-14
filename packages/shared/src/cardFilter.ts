/**
 * CardFilter の判定（T24）。
 *
 * 効果DSL の `filter` を実際のカードに当てる唯一の場所。
 * サーチ・トラッシュ・エネルギー加速がすべてここを通るので、
 * ここが間違うと全カードが間違う。
 *
 * ★条件は「指定されたものだけ」を見る。未指定のキーは素通し（AND 条件）。
 */
import type { CardFilter } from './dsl';
import type { CardText } from './types';

/**
 * カード定義が条件に合うか。
 * ★card が undefined（正体が見えない・定義がない）なら false。
 *   「分からないものを条件に合う」と扱うと、伏せたカードを勝手に選んでしまう。
 */
export function matchesCardFilter(
  card: CardText | undefined,
  filter: CardFilter | undefined,
): boolean {
  if (!card) return false;
  if (!filter) return true;

  if (filter.anyOf && !filter.anyOf.some((branch) => matchesCardFilter(card, branch))) return false;

  if (filter.supertype && !filter.supertype.includes(card.supertype)) return false;

  if (filter.stage && (card.stage === undefined || !filter.stage.includes(card.stage))) {
    return false;
  }

  // デュアルタイプがあるので「1つでも一致すれば合う」
  if (filter.types && !(card.types ?? []).some((t) => filter.types?.includes(t))) return false;
  // ★逆向きの条件。1つでも当てはまれば「合わない」
  if (filter.typesNot && (card.types ?? []).some((t) => filter.typesNot?.includes(t))) return false;

  if (filter.ruleBox !== undefined) {
    const hasRuleBox = card.ruleBox !== null && card.ruleBox !== undefined;
    if (filter.ruleBox === 'none' && hasRuleBox) return false;
    if (filter.ruleBox === 'any' && !hasRuleBox) return false;
    if (Array.isArray(filter.ruleBox)) {
      if (!hasRuleBox || !filter.ruleBox.includes(card.ruleBox ?? null)) return false;
    }
  }
  if (filter.ruleBoxNot?.includes(card.ruleBox ?? null)) return false;

  if (filter.nameExact && !filter.nameExact.includes(card.name)) return false;
  if (filter.nameNotExact?.includes(card.name)) return false;
  if (filter.nameContains && !card.name.includes(filter.nameContains)) return false;

  if (filter.hpMax !== undefined && (card.hp === undefined || card.hp > filter.hpMax)) return false;

  if (filter.isBasicEnergy !== undefined && card.isBasicEnergy !== filter.isBasicEnergy) {
    return false;
  }

  if (
    filter.energyProvides &&
    !(card.energyProvides ?? []).some((type) => filter.energyProvides?.includes(type))
  ) {
    return false;
  }

  if (filter.hasAbilities !== undefined && ((card.abilities?.length ?? 0) > 0) !== filter.hasAbilities) {
    return false;
  }

  if (
    filter.trainerKind &&
    (card.trainerKind === undefined || !filter.trainerKind.includes(card.trainerKind))
  ) {
    return false;
  }

  // 所属タグ。「ロケット団のポケモン」等。1つでも当てはまれば合う
  if (filter.tag && !(card.tags ?? []).some((t) => filter.tag?.includes(t))) return false;

  return true;
}
