/**
 * かかっている効果の可視化（第3段階 §5.2 / T26）。★重要
 *
 * 自動化が進むほど、盤面に何が効いているか目で見えなくなる。
 * ダメージが合わない原因のほとんどは「見えていない効果」なので、必ず出す。
 *
 *   - ポケモンには小さなバッジを重ねる（種類ごとに色分け）
 *   - ホバー（title）で内容と残り期間
 *   - 全体・プレイヤー単位の効果は盤面上部のバー（オルタージェネシスGX 等）
 *   - どれも押せば手で外せる（自動判定が取りこぼしても卓が止まらない）
 */
import type {
  Ability,
  ActionRequest,
  ActiveEffect,
  CardIndex,
  GameState,
  PlayerId,
  SlotId,
} from '@pokeca/shared';
import {
  describeEffect,
  DURATION_LABEL,
  effectSlotKey,
  effectsOnSlot,
  getEffectiveAbilities,
  globalEffects,
} from '@pokeca/shared';

import styles from './EffectBadges.module.css';

/** カードに印刷されている特性（ロックを考えない素の一覧） */
function printedAbilities(
  state: GameState,
  cardIndex: CardIndex | null,
  playerId: PlayerId,
  slotId: SlotId,
): Ability[] {
  const slot = state.players[playerId]?.pokemon.find((p) => p.slotId === slotId);
  const topId = slot?.stack[slot.stack.length - 1];
  const instance = topId ? state.cards[topId] : undefined;
  if (!instance || instance.functionalId === '') return [];
  return cardIndex?.byFunctionalId.get(instance.functionalId)?.abilities ?? [];
}
/** 種類ごとの色分け（§5.2）。CSS Modules のクラス名に対応させる */
const KIND_CLASS: Record<ActiveEffect['kind'], string> = {
  damageModifier: 'damage',
  preventAttackDamage: 'prevent',
  preventAttackEffect: 'prevent',
  cannotRetreat: 'block',
  cannotUseAttack: 'block',
  // ★ワザでかけるカード種別ロック（ガマゲロゲEX。T42）
  lockCardKind: 'block',
  // ★Ω連打などで増えるワザの回数（T39）
  extraAttack: 'custom',
  // ★どうぐ化したポケモン（クレッフィ等。T40）
  temporaryTool: 'custom',
  extraPrize: 'prize',
  custom: 'custom',
};

/** バッジに出す短い記号。1〜2文字に収める */
function markOf(effect: ActiveEffect): string {
  const delta = effect.payload['delta'];
  switch (effect.kind) {
    case 'damageModifier':
      return typeof delta === 'number' ? `${delta >= 0 ? '+' : ''}${delta}` : '±';
    case 'extraAttack':
      return '×2';
    case 'temporaryTool':
      return '⏳';
    case 'preventAttackDamage':
      return '盾';
    case 'preventAttackEffect':
      return '効';
    case 'cannotRetreat':
      return '逃';
    case 'cannotUseAttack':
      return '技';
    case 'lockCardKind':
      return '禁';
    case 'extraPrize':
      return typeof delta === 'number' ? `side${delta >= 0 ? '+' : ''}${delta}` : 'side';
    case 'custom':
      return '効';
  }
}

const tooltipOf = (effect: ActiveEffect): string =>
  `${describeEffect(effect)}\n${DURATION_LABEL[effect.duration.type]}\n出どころ: ${effect.source.label}`;

export interface EffectBadgesProps {
  state: GameState;
  playerId: PlayerId;
  slotId: SlotId;
  /** 特性が止まっているかを判定するために使う（T27） */
  cardIndex?: CardIndex | null;
  /** 押して外せるようにする。読み取り専用の盤面では省略 */
  dispatch?: (action: ActionRequest) => void;
}

/** ポケモン1匹にかかっている効果 */
export function EffectBadges({
  state,
  playerId,
  slotId,
  cardIndex = null,
  dispatch,
}: EffectBadgesProps) {
  const effects = effectsOnSlot(state, playerId, slotId);

  /*
   * ★特性が止まっているかは状態に書かれていない（§2.2 の派生状態）。
   *   見えないと「なぜ特性が使えないのか」が分からないので、ここで計算して出す。
   */
  const printed = printedAbilities(state, cardIndex, playerId, slotId);
  const effective = cardIndex
    ? getEffectiveAbilities(state, effectSlotKey(playerId, slotId), { cards: cardIndex })
    : printed;
  const lockedCount = printed.length - effective.length;

  if (effects.length === 0 && lockedCount === 0) return null;

  return (
    <span className={styles.badges} role="list" aria-label="かかっている効果">
      {lockedCount > 0 && (
        <span
          role="listitem"
          className={`${styles.badge} ${styles.locked}`}
          title={`特性が止まっています: ${printed
            .filter((a) => !effective.includes(a))
            .map((a) => a.name)
            .join(' / ')}`}
        >
          特性×
        </span>
      )}
      {effects.map((effect) => {
        const label = describeEffect(effect);
        const className = `${styles.badge} ${styles[KIND_CLASS[effect.kind]] ?? ''}`;
        if (!dispatch) {
          return (
            <span key={effect.effectId} role="listitem" className={className} title={tooltipOf(effect)}>
              {markOf(effect)}
            </span>
          );
        }
        return (
          <button
            key={effect.effectId}
            role="listitem"
            className={className}
            title={`${tooltipOf(effect)}\n\nクリックで外す`}
            aria-label={`${label}（クリックで外す）`}
            onClick={(e) => {
              e.stopPropagation();
              dispatch({ type: 'removeEffect', effectId: effect.effectId, label });
            }}
          >
            {markOf(effect)}
          </button>
        );
      })}
    </span>
  );
}

export interface GlobalEffectBarProps {
  state: GameState;
  dispatch?: (action: ActionRequest) => void;
}

/**
 * 盤面全体・プレイヤー単位の効果（§5.2）。
 * オルタージェネシスGX のように、どのポケモンにも紐づかないものをここに出す。
 */
export function GlobalEffectBar({ state, dispatch }: GlobalEffectBarProps) {
  const effects = globalEffects(state);
  if (effects.length === 0) return null;

  return (
    <div className={styles.bar} role="list" aria-label="場全体にかかっている効果">
      {effects.map((effect) => {
        const scope =
          'player' in effect.target
            ? (state.players[effect.target.player]?.displayName ?? effect.target.player)
            : '場全体';
        const label = describeEffect(effect);
        return (
          <span key={effect.effectId} role="listitem" className={styles.barItem} title={tooltipOf(effect)}>
            <span className={styles.barScope}>{scope}</span>
            <span className={styles.barLabel}>{label}</span>
            <span className={styles.barDuration}>{DURATION_LABEL[effect.duration.type]}</span>
            {dispatch && (
              <button
                className={styles.barRemove}
                aria-label={`${label} を外す`}
                onClick={() => dispatch({ type: 'removeEffect', effectId: effect.effectId, label })}
              >
                ×
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}
