/**
 * カードのフル表示（§6.3 / T51）。手札・ホバー拡大・詳細・デッキ構築で使う。
 *
 * ★実物のカードの **配置** に合わせる（画像・ロゴ・書体は使わない。絶対制約1・5）。
 *
 *     ┌──────────────────────────┐
 *     │ たね                 [水] │ 見出し帯（左=種類 / 右=タイプ）
 *     │ カード名            HP220 │
 *     ├──────────────────────────┤
 *     │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │ ★イラスト部。画像が無いので細い帯まで詰める
 *     ├──────────────────────────┤
 *     │ 特性・ワザ・効果のテキスト │ 本文（ここがいちばん広い）
 *     ├──────────────────────────┤
 *     │ 弱点 / 抵抗 / にげる      │ 足元。トレーナーズは決まり文句
 *     └──────────────────────────┘
 *
 * ★効果のテキストは必ずカードの中に出す。
 *   別の場所に出すと、カードを見ながら考えられない。
 */
import type { Ability, Attack, CardText } from '@pokeca/shared';
import { EnergyPips } from './EnergyPips';
import { EffectModeBadge } from './EffectModeBadge';
import {
  ABILITY_LABEL,
  cardKindLine,
  frameColor,
  RULE_BOX_LABEL,
  stripeBackground,
  TRAINER_LABEL,
  TRAINER_RULE_TEXT,
  TYPE_LABEL,
} from './cardVisuals';
import styles from './CardFull.module.css';

function AbilityBlock({ ability }: { ability: Ability }) {
  const variant =
    ability.kind === 'ancientTrait'
      ? styles.abilityAncient
      : ability.kind === 'ability'
        ? ''
        : styles.abilityLegacy;

  return (
    <div className={`${styles.ability} ${variant}`}>
      <div className={styles.abilityHead}>
        <span className={styles.abilityKind}>{ABILITY_LABEL[ability.kind]}</span>
        <span className={styles.abilityName}>{ability.name}</span>
      </div>
      {ability.text && <p className={styles.abilityText}>{ability.text}</p>}
    </div>
  );
}

function AttackBlock({ attack }: { attack: Attack }) {
  return (
    <div className={styles.attack}>
      <div className={styles.attackHead}>
        <span className={styles.attackCost}>
          <EnergyPips types={attack.cost} size="md" />
        </span>
        <span className={styles.attackName}>{attack.name}</span>
        {attack.damage && <span className={styles.damage}>{attack.damage}</span>}
      </div>
      {attack.text && <p className={styles.attackText}>{attack.text}</p>}
    </div>
  );
}

export interface CardFullProps {
  card: CardText | undefined;
  /** 中身が見えないカード。ウラのまま場に出したポケモンや相手の手札 */
  faceDown?: boolean;
  /** 押せるカードにする（デッキ構築で1枚増やす等）。渡さなければただの表示 */
  onClick?: () => void;
  className?: string;
}

export function CardFull({ card, faceDown = false, onClick, className = '' }: CardFullProps) {
  if (faceDown || !card) {
    return (
      <article className={`${styles.card} ${styles.faceDown} ${className}`}>
        <span>非公開</span>
      </article>
    );
  }

  const isPokemon = card.supertype === 'pokemon';
  const ruleBoxLabel = card.ruleBox ? RULE_BOX_LABEL[card.ruleBox] : null;
  const types = card.types ?? [];
  const ruleText = card.trainerKind ? TRAINER_RULE_TEXT[card.trainerKind] : null;

  return (
    <article
      className={`${styles.card} ${card.isAceSpec ? styles.ace : ''} ${
        onClick ? styles.clickable : ''
      } ${className}`}
      style={{ '--frame': frameColor(card) } as React.CSSProperties}
      {...(onClick
        ? {
            onClick,
            role: 'button',
            tabIndex: 0,
            onKeyDown: (event: React.KeyboardEvent) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onClick();
              }
            },
          }
        : {})}
    >
      {/* ── 見出し帯 ── */}
      <header className={styles.head}>
        <div className={styles.kindRow}>
          {/* ★実物と同じ割り当て。左は「トレーナーズ」、種類は右のバッジが担う（重複させない） */}
          <span className={styles.kind}>
            {card.supertype === 'trainer' ? 'トレーナーズ' : cardKindLine(card)}
          </span>
          <span className={styles.kindRight}>
            <EffectModeBadge effects={card.effects} />
            {(ruleBoxLabel || card.isAceSpec) && (
              <span className={`${styles.ruleBox} ${card.isAceSpec ? styles.aceBadge : ''}`}>
                {card.isAceSpec ? 'ACE SPEC' : ruleBoxLabel}
              </span>
            )}
            {isPokemon && types.length > 0 && <EnergyPips types={types} size="sm" />}
            {card.supertype === 'trainer' && card.trainerKind && (
              <span className={styles.subtype}>{TRAINER_LABEL[card.trainerKind]}</span>
            )}
          </span>
        </div>
        <div className={styles.nameRow}>
          <h3 className={styles.name}>{card.name}</h3>
          {isPokemon && card.hp !== undefined && (
            <span className={styles.hp}>
              <span className={styles.hpUnit}>HP</span>
              {card.hp}
            </span>
          )}
        </div>
      </header>

      {/* ★イラスト部。画像を扱わないので、タイプ色の帯まで詰めて残す */}
      <div className={styles.art} style={{ background: stripeBackground(card) }} />

      {/* ── 本文 ── */}
      <div className={styles.sections}>
        {card.abilities?.map((ability, i) => (
          <AbilityBlock key={`${ability.name}-${i}`} ability={ability} />
        ))}

        {card.attacks?.map((attack, i) => (
          <AttackBlock key={`${attack.name}-${i}`} attack={attack} />
        ))}

        {!isPokemon && card.text && (
          <div className={styles.plain}>
            <p className={styles.plainText}>{card.text}</p>
          </div>
        )}

        {card.supertype === 'energy' && !card.text && (
          <div className={styles.plain}>
            <p className={styles.plainText}>
              このカードは
              <EnergyPips types={card.energyProvides ?? []} size="sm" />
              エネルギーとしてはたらく。
            </p>
          </div>
        )}
      </div>

      {/* ── 足元 ── */}
      {isPokemon ? (
        <footer className={styles.footer}>
          <span className={styles.footItem}>
            <span className={styles.footLabel}>弱点</span>
            {card.weakness ? (
              <>
                <EnergyPips types={[card.weakness.type]} size="sm" />
                <span className={styles.footValue}>{card.weakness.modifier}</span>
              </>
            ) : (
              <span className={styles.footValue}>—</span>
            )}
          </span>

          <span className={styles.footItem}>
            <span className={styles.footLabel}>抵抗</span>
            {card.resistance ? (
              <>
                <EnergyPips types={[card.resistance.type]} size="sm" />
                <span className={styles.footValue}>{card.resistance.modifier}</span>
              </>
            ) : (
              <span className={styles.footValue}>—</span>
            )}
          </span>

          <span className={styles.footItem}>
            <span className={styles.footLabel}>にげる</span>
            {card.retreatCost && card.retreatCost > 0 ? (
              <EnergyPips
                types={Array.from({ length: card.retreatCost }, () => 'colorless' as const)}
                size="sm"
              />
            ) : (
              <span className={styles.footValue}>—</span>
            )}
          </span>

          {types.length > 1 && (
            <span className={styles.footItem}>
              <span className={styles.footLabel}>{types.map((t) => TYPE_LABEL[t]).join('・')}</span>
            </span>
          )}
        </footer>
      ) : (
        /* ★トレーナーズの決まり文句。実物と同じく下端に置く */
        ruleText && <footer className={styles.ruleFooter}>{ruleText}</footer>
      )}
    </article>
  );
}
