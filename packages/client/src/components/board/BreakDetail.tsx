/**
 * BREAK進化の内訳（第4段階 §4.3 / T37）。
 *
 * ★「どちらのカード由来か」を必ず示す。
 *   BREAKは引きつぐものと引きつがないものが混ざるので、
 *   名前とHPだけ見て弱点を取り違える事故が起きやすい。
 */
import type { EffectiveProfile } from '@pokeca/shared';
import styles from './BreakDetail.module.css';

const TYPE_LABEL: Record<string, string> = {
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

const modifierText = (m: { type: string; modifier: string } | null | undefined): string =>
  m ? `${TYPE_LABEL[m.type] ?? m.type} ${m.modifier}` : 'なし';

export function BreakDetail({ profile }: { profile: EffectiveProfile }) {
  if (!profile.isBreak) return null;

  const topName = profile.top?.card?.name ?? 'BREAK';
  const baseName = profile.base?.card?.name ?? '進化前';

  /** 1行ぶん。値と、それがどちらのカード由来かを並べる */
  const row = (label: string, value: string, from: string) => (
    <li className={styles.row} key={label}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{value}</span>
      <span className={styles.from}>{from}</span>
    </li>
  );

  return (
    <section className={styles.panel} aria-label="BREAK進化の内訳">
      <p className={styles.head}>
        <b>{topName}</b>
        <span className={styles.over}>を</span>
        <b>{baseName}</b>
        <span className={styles.over}>に重ねている</span>
      </p>
      <ul className={styles.rows}>
        {/* ★引きつぐもの */}
        {row(
          'ワザ',
          profile.attacks.length > 0
            ? profile.attacks.map((entry) => entry.attack.name).join(' / ')
            : 'なし',
          baseName,
        )}
        {row('弱点', modifierText(profile.weakness), baseName)}
        {row('抵抗力', modifierText(profile.resistance), baseName)}
        {row('にげる', `${profile.retreatCost}`, baseName)}
        {/* ★BREAK側を使うもの */}
        {row(
          'タイプ',
          profile.types.map((t) => TYPE_LABEL[t] ?? t).join('・') || '—',
          topName,
        )}
        {row('HP', profile.hp === undefined ? '—' : `${profile.hp}`, topName)}
        {/* 特性は両方から集まる */}
        {profile.abilities.length > 0 &&
          row(
            '特性',
            profile.abilities.map((entry) => entry.ability.name).join(' / '),
            [...new Set(profile.abilities.map((entry) => entry.from.card?.name ?? '?'))].join(' + '),
          )}
      </ul>
    </section>
  );
}
