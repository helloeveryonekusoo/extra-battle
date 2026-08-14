/**
 * カードのフル表示（§6.3）。手札・ホバー拡大・詳細で使う。
 *
 * 画像がないので、成立させるのはタイポグラフィと色だけ:
 *   - 左端6pxのタイプ色帯で一瞥してタイプが分かる
 *   - エネルギーコストは色付きの円。文字にしない
 *   - ダメージ値は大きく右寄せ
 *   - 特性は枠で囲み背景を一段明るくして、ワザと明確に区別する
 *   - ルールボックスは右上の小さなバッジ、ACE SPEC は枠に金
 */
import type { Ability, Attack, CardText } from '@pokeca/shared';
import { EnergyPips } from './EnergyPips';
import { EffectModeBadge } from './EffectModeBadge';
import {
  ABILITY_LABEL,
  cardKindLine,
  RULE_BOX_LABEL,
  stripeBackground,
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
  className?: string;
}

export function CardFull({ card, faceDown = false, className = '' }: CardFullProps) {
  if (faceDown || !card) {
    return (
      <article className={`${styles.card} ${styles.faceDown} ${className}`}>
        <span>非公開</span>
      </article>
    );
  }

  const isPokemon = card.supertype === 'pokemon';
  const ruleBoxLabel = card.ruleBox ? RULE_BOX_LABEL[card.ruleBox] : null;

  return (
    <article className={`${styles.card} ${card.isAceSpec ? styles.ace : ''} ${className}`}>
      <div className={styles.stripe} style={{ background: stripeBackground(card) }} />

      <div className={styles.body}>
        {(ruleBoxLabel || card.isAceSpec) && (
          <span className={`${styles.ruleBox} ${card.isAceSpec ? styles.aceBadge : ''}`}>
            {card.isAceSpec ? 'ACE SPEC' : ruleBoxLabel}
          </span>
        )}

        <header className={styles.head}>
          <div className={styles.nameRow}>
            <h3 className={styles.name}>{card.name}</h3>
            {isPokemon && card.hp !== undefined && (
              <span className={styles.hp}>
                <span className={styles.hpUnit}>HP</span>
                {card.hp}
              </span>
            )}
          </div>
          <div className={styles.kindLine}>
            <span>{cardKindLine(card)}</span>
            <EffectModeBadge effects={card.effects} />
          </div>
        </header>

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

        {isPokemon && (
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

            {card.types && card.types.length > 1 && (
              <span className={styles.footItem}>
                <span className={styles.footLabel}>
                  {card.types.map((t) => TYPE_LABEL[t]).join('・')}
                </span>
              </span>
            )}
          </footer>
        )}
      </div>
    </article>
  );
}
