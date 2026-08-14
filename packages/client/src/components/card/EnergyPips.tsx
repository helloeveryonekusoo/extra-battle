/**
 * エネルギーの色付き円（§6.3）。
 * 公式のエネルギー記号画像は使わない。文字にもしない。色と形だけで示す。
 */
import type { EnergyType } from '@pokeca/shared';
import { TYPE_COLOR, TYPE_LABEL } from './cardVisuals';
import styles from './EnergyPips.module.css';

export type PipSize = 'sm' | 'md' | 'lg';

export function EnergyPip({
  type,
  size = 'md',
  filled = true,
}: {
  type: EnergyType;
  size?: PipSize;
  filled?: boolean;
}) {
  return (
    <span
      className={`${styles.pip} ${styles[size]} ${filled ? '' : styles.empty}`}
      style={{ background: TYPE_COLOR[type] }}
      title={TYPE_LABEL[type]}
      aria-label={TYPE_LABEL[type]}
      role="img"
    />
  );
}

export function EnergyPips({
  types,
  size = 'md',
  /** 未充足として薄く出す個数（ワザのコストに対して足りない分） */
  emptyCount = 0,
  emptyType = 'colorless',
}: {
  types: readonly EnergyType[];
  size?: PipSize;
  emptyCount?: number;
  emptyType?: EnergyType;
}) {
  if (types.length === 0 && emptyCount === 0) {
    return <span className={styles.none}>—</span>;
  }
  return (
    <span className={styles.row}>
      {types.map((type, i) => (
        <EnergyPip key={`f${i}`} type={type} size={size} />
      ))}
      {Array.from({ length: emptyCount }, (_, i) => (
        <EnergyPip key={`e${i}`} type={emptyType} size={size} filled={false} />
      ))}
    </span>
  );
}
