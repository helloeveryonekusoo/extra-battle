/**
 * 盤面のコンパクト表示（§6.3）と特殊状態の表現（§6.4）。
 *
 * 実物のカードの挙動を画面上で再現する:
 *   ねむり / マヒ → カードを 90° 回転
 *   こんらん     → カードを 180° 回転（上下逆）
 *   どく / やけど → マーカーバッジ + 縁が脈動
 *
 * 回転は Framer Motion で 0.3秒。瞬間的に切り替えない。
 */
import { motion } from 'framer-motion';
import {
  ONCE_PER_GAME_LABEL,
  type CardText,
  type EnergyType,
  type OncePerGameKind,
  type SpecialCondition,
} from '@pokeca/shared';
import { EnergyPips } from './EnergyPips';
import { EffectModeBadge } from './EffectModeBadge';
import { hpColor, stripeBackground } from './cardVisuals';
import styles from './CardCompact.module.css';

const CONDITION_LABEL: Record<SpecialCondition, string> = {
  poisoned: 'どく',
  burned: 'やけど',
  asleep: 'ねむり',
  paralyzed: 'マヒ',
  confused: 'こんらん',
};

/** HPバーの目盛りの数。多すぎると潰れるので固定 */
const TICKS = 8;

/** バッジに出す短い名前（T36） */
const ONCE_PER_GAME_BADGE: Record<OncePerGameKind, string> = {
  gx: 'GX',
  vstar: 'VSTAR',
  vunion: 'V-UNION',
};

/**
 * 特殊状態から回転角を出す。
 * ねむり・マヒで 90°、こんらんで 180°。両方なら 270°（実物と同じ挙動）。
 */
export function rotationFor(conditions: readonly SpecialCondition[]): number {
  let deg = 0;
  if (conditions.includes('asleep') || conditions.includes('paralyzed')) deg += 90;
  if (conditions.includes('confused')) deg += 180;
  return deg;
}

export interface CardCompactProps {
  card: CardText | undefined;
  /** ついているエネルギーの粒。★1粒＝1個ぶん（枚数ではない。T33） */
  energy?: readonly EnergyType[];
  /** 「何個ぶん」の内訳。粒にマウスを乗せたときに出す */
  energyTitle?: string;
  /**
   * ★持ち主が使い切った「対戦中1回」の枠（T36）。
   *   枠はプレイヤー単位なので、バッジの点灯・消灯はここから決める。
   */
  oncePerGameUsed?: readonly OncePerGameKind[];
  /**
   * BREAK進化しているとき、下に敷かれているカードの名前（T37 / §4.3）。
   * ★指定すると実物どおり横向きに重ねて表示し、下の名前が覗く。
   */
  breakUnder?: string | null;
  /** V-UNION（4枚で1匹）として組み上がっているか（T38）。進化枚数とは別物 */
  isVUnion?: boolean;
  /** ダメカンの数。×10 がダメージ量 */
  damageCounters?: number;
  conditions?: readonly SpecialCondition[];
  /** ついているどうぐの名前 */
  toolName?: string | null;
  /** そのどうぐが相手のカードか（フレア団ハイパーギア等。T40） */
  toolIsOpponents?: boolean;
  /** 進化スタックの枚数（2枚以上なら表示する） */
  stackSize?: number;
  /**
   * ★特性の一覧と、それが止まっているか（§4.1 / T42）。
   *   止まっていても消さない。グレーアウト＋取り消し線で出す。
   */
  abilities?: readonly {
    name: string;
    locked: boolean;
    assisted: boolean;
    reason: string;
  }[];
  faceDown?: boolean;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  /** ダメージ表示のクリック（§6.6 クリック +10 / Shift+クリック +50 / 右クリック −10） */
  onDamageClick?: (e: React.MouseEvent) => void;
  onPointerDown?: (e: React.PointerEvent) => void;
  className?: string;
}

export function CardCompact({
  card,
  energy = [],
  energyTitle = '',
  oncePerGameUsed = [],
  breakUnder = null,
  isVUnion = false,
  damageCounters = 0,
  conditions = [],
  toolName = null,
  toolIsOpponents = false,
  stackSize = 1,
  abilities = [],
  faceDown = false,
  onClick,
  onContextMenu,
  onDamageClick,
  onPointerDown,
  className = '',
}: CardCompactProps) {
  const hidden = faceDown || !card;
  const maxHp = card?.hp ?? 0;
  const damage = damageCounters * 10;
  const remaining = Math.max(0, maxHp - damage);
  const filledTicks = maxHp > 0 ? Math.ceil((remaining / maxHp) * TICKS) : 0;
  const barColor = hpColor(remaining, maxHp);

  /** そのカードが持つ「対戦中1回」の枠。ワザと特性の両方から集める（T36） */
  const oncePerGameKinds = [
    ...new Set(
      [
        ...(card?.attacks ?? []).map((attack) => attack.oncePerGame),
        ...(card?.abilities ?? []).map((ability) => ability.oncePerGame),
      ].filter((kind): kind is OncePerGameKind => kind !== undefined),
    ),
  ];

  const pulse = conditions.includes('poisoned')
    ? styles.pulsePoison
    : conditions.includes('burned')
      ? styles.pulseBurn
      : '';

  return (
    <div className={`${styles.wrap} ${breakUnder ? styles.breakWrap : ''} ${className}`}>
      {/*
        ★BREAK進化は実物どおり **横向きに重ねて** 表示する（§4.3）。
          下のカードの名前が覗くように、少し上にずらして回転させる。
      */}
      {breakUnder && (
        <div className={styles.breakUnder} aria-hidden={false}>
          <span className={styles.breakUnderName}>{breakUnder}</span>
          <span className={styles.breakUnderTag}>ワザ・弱点・にげるはこちら</span>
        </div>
      )}
      <motion.div
        className={`${styles.card} ${hidden ? styles.faceDown : ''} ${
          card?.isAceSpec ? styles.ace : ''
        } ${breakUnder ? styles.breakTop : ''} ${pulse}`}
        animate={{ rotate: rotationFor(conditions) }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
        onClick={onClick}
        onContextMenu={onContextMenu}
        onPointerDown={onPointerDown}
      >
        {hidden ? (
          <span className={styles.faceDownLabel}>非公開</span>
        ) : (
          <>
            <EffectModeBadge effects={card.effects} compact />
            <div className={styles.stripe} style={{ background: stripeBackground(card) }} />
            <div className={styles.body}>
              <div className={styles.name}>{card.name}</div>

              {stackSize > 1 && (
                <div className={styles.stackHint}>
                  {isVUnion
                    ? `V-UNION（${stackSize}枚）`
                    : breakUnder
                      ? `BREAK（${stackSize}枚）`
                      : `進化 ${stackSize}枚`}
                </div>
              )}

              <div className={styles.energy} {...(energyTitle ? { title: energyTitle } : {})}>
                {energy.length > 0 && <EnergyPips types={energy} size="sm" />}
              </div>

              {/* ★対戦中1回のワザ・特性を持つポケモン（T36）。使い切っていれば消灯する */}
              {oncePerGameKinds.length > 0 && (
                <div className={styles.once}>
                  {oncePerGameKinds.map((kind) => (
                    <span
                      key={kind}
                      className={`${styles.onceBadge} ${
                        oncePerGameUsed.includes(kind) ? styles.onceBadgeUsed : ''
                      }`}
                      title={
                        oncePerGameUsed.includes(kind)
                          ? `${ONCE_PER_GAME_LABEL[kind]}はこの対戦でもう使えません（プレイヤーごとに1回）`
                          : `${ONCE_PER_GAME_LABEL[kind]}が使えます（プレイヤーごとに1回）`
                      }
                    >
                      {ONCE_PER_GAME_BADGE[kind]}
                    </span>
                  ))}
                </div>
              )}

              {/* ★特性の状態（§4.1）。止まっているものは取り消し線 + 理由をホバーで */}
              {abilities.length > 0 && (
                <div className={styles.abilities}>
                  {abilities.map((ability, i) => (
                    <span
                      key={`${ability.name}-${i}`}
                      className={`${styles.ability} ${ability.locked ? styles.abilityLocked : ''} ${
                        ability.assisted ? styles.abilityAssisted : ''
                      }`}
                      title={
                        ability.locked
                          ? `特性「${ability.name}」は止まっています：${ability.reason}` +
                            (ability.assisted ? '（ロックが複数。要確認）' : '')
                          : `特性「${ability.name}」`
                      }
                    >
                      {ability.name}
                    </span>
                  ))}
                </div>
              )}

              {toolName && (
                <div className={styles.tool}>
                  🔧 {toolName}
                  {/* ★持ち主が違うどうぐは、そう分かるようにする（T40） */}
                  {toolIsOpponents && <span className={styles.toolForeign}>相手のカード</span>}
                </div>
              )}

              {conditions.length > 0 && (
                <div className={styles.conditions}>
                  {conditions.map((c) => (
                    <span key={c} className={`${styles.condition} ${styles[c]}`}>
                      {CONDITION_LABEL[c]}
                    </span>
                  ))}
                </div>
              )}

              {maxHp > 0 && (
                <div
                  className={`${styles.hpBlock} ${onDamageClick ? styles.hpClickable : ''}`}
                  {...(onDamageClick
                    ? {
                        onClick: (e: React.MouseEvent) => {
                          e.stopPropagation();
                          onDamageClick(e);
                        },
                        onContextMenu: (e: React.MouseEvent) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onDamageClick(e);
                        },
                        title: 'クリック +10 / Shift+クリック +50 / 右クリック −10',
                      }
                    : {})}
                >
                  <div className={styles.hpBar}>
                    {Array.from({ length: TICKS }, (_, i) => (
                      <span
                        key={i}
                        className={styles.tick}
                        style={i < filledTicks ? { background: barColor } : undefined}
                      />
                    ))}
                  </div>
                  <div
                    className={`${styles.hpText} ${remaining === 0 ? styles.hpTextLow : ''}`}
                  >
                    {remaining}/{maxHp}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </motion.div>
    </div>
  );
}

/** ポケモンがいないスロット */
export function EmptySlot({ label = 'ベンチ' }: { label?: string }) {
  return (
    <div className={styles.wrap}>
      <div className={`${styles.card} ${styles.empty}`}>{label}</div>
    </div>
  );
}
