import { effectModeOf, type Op } from '@pokeca/shared';
import styles from './EffectModeBadge.module.css';

export interface EffectModeBadgeProps {
  effects: readonly Op[] | null | undefined;
  compact?: boolean;
}

const MODE_TITLE = {
  AUTO: 'カード効果を自動実行',
  ASSISTED: '一部を手動操作して実行',
  MANUAL: 'カード効果は手動操作',
} as const;

/** カード定義と同じ判定関数を使うため、表示と実行経路が食い違わない。 */
export function EffectModeBadge({ effects, compact = false }: EffectModeBadgeProps) {
  const mode = effectModeOf(effects);
  return (
    <span
      className={`${styles.badge} ${styles[mode.toLowerCase()]} ${compact ? styles.compact : ''}`}
      title={MODE_TITLE[mode]}
      data-effect-mode={mode}
    >
      {mode}
    </span>
  );
}
