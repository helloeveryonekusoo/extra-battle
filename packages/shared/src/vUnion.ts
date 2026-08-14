/**
 * V-UNION（第4段階 T38）。
 *
 * 4種類のカードが揃って **1匹のポケモン** になる。
 *   - 対戦中1回だけ、自分の **トラッシュにある4種類** を組み合わせてベンチに出す
 *   - 4枚揃っていない、またはサイドに落ちていれば出せない
 *   - きぜつでサイド3枚（T36 の表で対応済み）
 *
 * ★盤面上は「4枚を1つのスタックに積む」形で表す。
 *   進化スタックと同じ入れ物を使うので、きぜつ・回収・可視性の処理を作り直さずに済む。
 *   ただし「一番上がそのポケモンのすべて」ではないので、
 *   ワザやHPは effectiveCard.ts が4枚ぶんを合成して答える。
 *
 * ★サイドに落ちているかは **数えられるが中身は見えない**。
 *   ここでは「トラッシュに何番が揃っているか」だけを見て、
 *   足りない番号を「どこかにある」と伝える。山札やサイドを覗きに行かない。
 */
import type { RuleContext } from './rules';
import type { CardText, GameState, PlayerId } from './types';

/** V-UNION のカードか */
export const isVUnionCard = (card: CardText | undefined): boolean =>
  card?.ruleBox === 'VUNION' || card?.stage === 'vunion';

/** V-UNION は4枚で1匹 */
export const V_UNION_PARTS = 4;

export interface VUnionPart {
  instanceId: string;
  card: CardText;
  /** 1〜4。宣言がなければ 0（並べ替えのときは最後に回す） */
  part: number;
}

export interface VUnionGroup {
  /** 同じ名前の4枚で1組 */
  name: string;
  /** トラッシュにあるぶん。part 順 */
  parts: VUnionPart[];
  /** 足りない番号 */
  missing: number[];
  /** 4種類そろっているか */
  complete: boolean;
}

/**
 * そのプレイヤーのトラッシュにある V-UNION を、名前ごとにまとめる。
 * ★同じ番号が2枚あっても1枚ぶんとして数える（組み立てには1枚ずつしか要らない）。
 */
export function vUnionGroupsInDiscard(
  state: GameState,
  playerId: PlayerId,
  ctx: RuleContext = {},
): VUnionGroup[] {
  const byName = new Map<string, Map<number, VUnionPart>>();

  for (const instance of Object.values(state.cards)) {
    if (instance.ownerId !== playerId || instance.zone !== 'discard') continue;
    if (instance.functionalId === '') continue;
    const card = ctx.cards?.byFunctionalId.get(instance.functionalId);
    if (!isVUnionCard(card) || !card) continue;

    const part = card.vUnionPart ?? 0;
    const parts = byName.get(card.name) ?? new Map<number, VUnionPart>();
    // 同じ番号が複数あるときは先に見つけたほうを使う
    if (!parts.has(part)) parts.set(part, { instanceId: instance.instanceId, card, part });
    byName.set(card.name, parts);
  }

  return [...byName]
    .map(([name, parts]) => {
      const found = [...parts.values()].sort((a, b) => a.part - b.part);
      const numbers = new Set(found.map((entry) => entry.part));
      const missing = Array.from({ length: V_UNION_PARTS }, (_, i) => i + 1).filter(
        (n) => !numbers.has(n),
      );
      return { name, parts: found, missing, complete: missing.length === 0 };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 組み立てられるか。
 * ★止めるための判定ではなく、UIに理由を出すための判定（第2段階 §2）。
 */
export interface VUnionReadiness {
  ready: boolean;
  /** 画面にそのまま出す日本語。問題なければ null */
  reason: string | null;
}

export function checkVUnionAssembly(
  group: VUnionGroup | undefined,
  alreadyUsed: boolean,
  benchHasRoom: boolean,
): VUnionReadiness {
  if (!group) return { ready: false, reason: 'トラッシュに V-UNION がありません' };
  if (alreadyUsed) {
    return { ready: false, reason: 'V-UNION はこの対戦ですでに組み立てています' };
  }
  if (!group.complete) {
    return {
      ready: false,
      // ★どこにあるかは言わない。サイドの中身を推測させない
      reason: `${group.missing.join('・')}枚目がトラッシュにありません（山札かサイドにあります）`,
    };
  }
  if (!benchHasRoom) return { ready: false, reason: 'ベンチに空きがありません' };
  return { ready: true, reason: null };
}
