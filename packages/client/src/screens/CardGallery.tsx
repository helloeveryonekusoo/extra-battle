/**
 * T7 の見本ページ。
 * 全タイプ・全ルールボックス・特殊状態つきのカードを並べて、
 * 画像なしでも状況が一瞥で分かることを確認する。
 */
import { useMemo, type ReactNode } from 'react';
import type { CardText, EnergyType, RuleBox, SpecialCondition } from '@pokeca/shared';
import { CardFull } from '../components/card/CardFull';
import { CardCompact, EmptySlot } from '../components/card/CardCompact';
import { RULE_BOX_LABEL, TYPE_LABEL } from '../components/card/cardVisuals';
import { loadCardPool } from '../cards/cardPool';
import styles from './CardGallery.module.css';

const ALL_TYPES: EnergyType[] = [
  'grass',
  'fire',
  'water',
  'lightning',
  'psychic',
  'fighting',
  'darkness',
  'metal',
  'fairy',
  'dragon',
  'colorless',
];

const ALL_RULE_BOXES: NonNullable<RuleBox>[] = [
  'EX',
  'MEGA',
  'BREAK',
  'GX',
  'PRISM',
  'TAGTEAM',
  'V',
  'VMAX',
  'VUNION',
  'VSTAR',
  'RADIANT',
  'ex',
];

const CONDITION_SETS: { label: string; conditions: SpecialCondition[] }[] = [
  { label: '（なし）', conditions: [] },
  { label: 'ねむり → 90°', conditions: ['asleep'] },
  { label: 'マヒ → 90°', conditions: ['paralyzed'] },
  { label: 'こんらん → 180°', conditions: ['confused'] },
  { label: 'どく → 紫に脈動', conditions: ['poisoned'] },
  { label: 'やけど → 橙に脈動', conditions: ['burned'] },
  { label: 'どく + こんらん', conditions: ['poisoned', 'confused'] },
  { label: 'ねむり + こんらん → 270°', conditions: ['asleep', 'confused'] },
];

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{title}</h2>
        {note && <span className={styles.sectionNote}>{note}</span>}
      </div>
      <div className={styles.grid}>{children}</div>
    </section>
  );
}

function Specimen({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className={styles.specimen}>
      {children}
      <span className={styles.caption}>{caption}</span>
    </div>
  );
}

export function CardGallery({ onClose }: { onClose?: () => void }) {
  const pool = loadCardPool().index;
  const cards = pool.all;

  /** タイプごとの代表カード */
  const byType = useMemo(() => {
    const map = new Map<EnergyType, CardText>();
    for (const type of ALL_TYPES) {
      const found = cards.find((c) => c.supertype === 'pokemon' && c.types?.includes(type));
      if (found) map.set(type, found);
    }
    return map;
  }, [cards]);

  const base = byType.get('water') ?? cards.find((c) => c.supertype === 'pokemon');
  const kamex = pool.byName.get('カメックス')?.[0];
  const lizardon = pool.byName.get('リザードンex')?.[0];
  const yamikarasu = pool.byName.get('ヤミカラス')?.[0];
  const lizardo = pool.byName.get('リザード')?.[0];
  const aceSpec = cards.find((c) => c.isAceSpec);
  const trainers = (['item', 'tool', 'supporter', 'stadium'] as const).map((kind) =>
    cards.find((c) => c.supertype === 'trainer' && c.trainerKind === kind && !c.isAceSpec),
  );
  const energies = cards.filter((c) => c.supertype === 'energy').slice(0, 5);

  if (cards.length === 0) {
    return (
      <div className={styles.shell}>
        <p className={styles.missing}>
          サンプルカードが読み込めませんでした。<code>data/cards/sample.json</code> を確認してください。
        </p>
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <div className={styles.head}>
        <h1 className={styles.title}>カード見本</h1>
        {onClose && (
          <button className={styles.back} onClick={onClose}>
            もどる
          </button>
        )}
      </div>
      <p className={styles.lead}>
        画像を一切使わず、タイプ色の帯・自作の色付き円・タイポグラフィだけでカードを成立させています。
        左端6pxの帯でタイプ、右上のバッジでルールボックス、金の枠で ACE SPEC が分かります。
      </p>

      <Section title="全11タイプ" note="左端の帯の色で見分ける">
        {ALL_TYPES.map((type) => {
          const card = byType.get(type);
          return (
            <Specimen key={type} caption={TYPE_LABEL[type]}>
              {card ? <CardFull card={card} /> : <EmptySlot label="—" />}
            </Specimen>
          );
        })}
      </Section>

      <Section title="特性・ワザの書き分け" note="特性は枠で囲み背景を一段明るくする">
        {[kamex, lizardo, yamikarasu, lizardon].map(
          (card, i) =>
            card && (
              <Specimen
                key={card.functionalId}
                caption={
                  ['特性 + 加算/乗算ダメージ', '特性 + 古代能力', 'ポケパワー + ポケボディー', 'ex（ルールボックス）'][
                    i
                  ] ?? ''
                }
              >
                <CardFull card={card} />
              </Specimen>
            ),
        )}
      </Section>

      <Section title="全ルールボックス" note="右上の小さなバッジ。実データにない種類は見本として合成">
        {ALL_RULE_BOXES.map((ruleBox) => {
          if (!base) return null;
          const specimen: CardText = { ...base, name: `見本 ${RULE_BOX_LABEL[ruleBox]}`, ruleBox };
          return (
            <Specimen key={ruleBox} caption={ruleBox}>
              <CardFull card={specimen} />
            </Specimen>
          );
        })}
      </Section>

      <Section title="ACE SPEC" note="枠に金色のアクセント">
        {aceSpec && (
          <Specimen caption={aceSpec.name}>
            <CardFull card={aceSpec} />
          </Specimen>
        )}
      </Section>

      <Section title="トレーナーズ・エネルギー" note="ポケモン以外は中立色の帯 + 種別ラベル">
        {trainers.map(
          (card) =>
            card && (
              <Specimen key={card.functionalId} caption={card.name}>
                <CardFull card={card} />
              </Specimen>
            ),
        )}
        {energies.map((card) => (
          <Specimen key={card.functionalId} caption={card.name}>
            <CardFull card={card} />
          </Specimen>
        ))}
      </Section>

      <Section title="伏せカード" note="ウラのまま場に出す・相手の手札">
        <Specimen caption="非公開">
          <CardFull card={undefined} faceDown />
        </Specimen>
      </Section>

      <Section title="盤面表示（コンパクト）" note="HPバーは残量で緑→黄→赤">
        {[0, 3, 7, 11, 18].map((counters) => (
          <Specimen key={counters} caption={`ダメカン ${counters}個`}>
            <CardCompact
              card={kamex}
              energy={['water', 'water', 'colorless']}
              damageCounters={counters}
              toolName="スピードふうせん"
            />
          </Specimen>
        ))}
        <Specimen caption="進化スタック">
          <CardCompact card={kamex} energy={['water']} stackSize={3} />
        </Specimen>
        <Specimen caption="ウラのまま">
          <CardCompact card={undefined} faceDown />
        </Specimen>
        <Specimen caption="空きスロット">
          <EmptySlot />
        </Specimen>
      </Section>

      <Section title="特殊状態" note="実物のカードと同じ挙動。回転は 0.3秒でアニメーションする">
        {CONDITION_SETS.map((set) => (
          <Specimen key={set.label} caption={set.label}>
            <CardCompact
              card={kamex}
              energy={['water', 'water']}
              damageCounters={5}
              conditions={set.conditions}
            />
          </Specimen>
        ))}
      </Section>
    </div>
  );
}
