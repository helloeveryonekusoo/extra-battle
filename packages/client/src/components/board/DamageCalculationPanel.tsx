import { useMemo, useState } from 'react';
import {
  damageInputFromState,
  effectiveProfileOf,
  runDamagePipeline,
  suggestedBaseDamage,
  topCardOf,
  type ActionRequest,
  type CardIndex,
  type GameState,
  type PlayerId,
  type EffectiveProfile,
  type PokemonInPlay,
} from '@pokeca/shared';
import styles from './DamageCalculationPanel.module.css';

interface SlotChoice {
  key: string;
  playerId: PlayerId;
  slot: PokemonInPlay;
  topInstanceId: string;
  card: NonNullable<ReturnType<typeof topCardOf>>;
  /** BREAK進化を合成した姿（T37） */
  profile: EffectiveProfile;
}

function choicesOf(
  state: GameState,
  cardIndex: CardIndex | null,
  playerFilter?: PlayerId,
): SlotChoice[] {
  if (!cardIndex) return [];
  const choices: SlotChoice[] = [];
  for (const [playerId, player] of Object.entries(state.players)) {
    if (playerFilter && playerId !== playerFilter) continue;
    for (const slot of player.pokemon) {
      const card = topCardOf(state, { cards: cardIndex }, slot);
      const topInstanceId = slot.stack.at(-1);
      if (!card || !topInstanceId) continue;
      /*
       * ★BREAK進化しているとワザ・弱点・抵抗力は進化前から引きつぐ（T37）。
       *   一番上のカードだけを見ると弱点を取り違えるので、合成した姿も持たせる。
       */
      const profile = effectiveProfileOf(state, playerId, slot.slotId, { cards: cardIndex });
      choices.push({
        key: `${playerId}/${slot.slotId}`,
        playerId,
        slot,
        topInstanceId,
        card,
        profile,
      });
    }
  }
  return choices;
}

const slotLabel = (slot: PokemonInPlay) =>
  slot.slotId === 'active' ? 'バトル場' : `ベンチ${Number(slot.slotId.split('-')[1]) + 1}`;

export function DamageCalculationPanel({
  state,
  viewerId,
  cardIndex,
  dispatch,
  onClose,
}: {
  state: GameState;
  viewerId: PlayerId;
  cardIndex: CardIndex | null;
  dispatch: (action: ActionRequest) => void;
  onClose: () => void;
}) {
  const attackers = useMemo(
    () => choicesOf(state, cardIndex, viewerId).filter((choice) => choice.profile.attacks.length > 0),
    [state, cardIndex, viewerId],
  );
  const targets = useMemo(() => choicesOf(state, cardIndex), [state, cardIndex]);
  const defaultTarget =
    targets.find((choice) => choice.playerId !== viewerId && choice.slot.slotId === 'active') ??
    targets[0];

  const [attackerKey, setAttackerKey] = useState(attackers[0]?.key ?? '');
  const [attackIndex, setAttackIndex] = useState(0);
  const [targetKey, setTargetKey] = useState(defaultTarget?.key ?? '');
  const selectedAttacker = attackers.find((choice) => choice.key === attackerKey) ?? attackers[0];
  const selectedTarget = targets.find((choice) => choice.key === targetKey) ?? defaultTarget;
  // 使えるワザも合成した姿から（BREAKなら進化前のワザ）
  const attackList = selectedAttacker?.profile.attacks.map((entry) => entry.attack) ?? [];
  const selectedAttack = attackList[attackIndex] ?? attackList[0];

  const [baseDamage, setBaseDamage] = useState(() => suggestedBaseDamage(selectedAttack?.damage ?? ''));
  const [baseConfirmed, setBaseConfirmed] = useState(false);
  const [manualAdjustment, setManualAdjustment] = useState(0);
  const [useWeakness, setUseWeakness] = useState(true);
  const [useResistance, setUseResistance] = useState(true);
  const [applyToBench, setApplyToBench] = useState(false);

  /** ワザ本文「弱点・抵抗力を計算しない」「かかっている効果を計算しない」 */
  const [skipWeaknessResistance, setSkipWeaknessResistance] = useState(false);
  const [ignoreTargetEffects, setIgnoreTargetEffects] = useState(false);

  /*
   * ★6段パイプライン（§4.1 / T28）にそのまま流す。
   *   与える側の効果は Step2、受ける側は Step5。振り分けは damageInputFromState が行う。
   */
  const calculation =
    selectedAttacker && selectedTarget
      ? runDamagePipeline(
          damageInputFromState(
            state,
            { cards: cardIndex },
            { playerId: selectedAttacker.playerId, slotId: selectedAttacker.slot.slotId },
            { playerId: selectedTarget.playerId, slotId: selectedTarget.slot.slotId },
            {
              baseDamage,
              // タイプは ★BREAK側 / 弱点・抵抗力は ★進化前 から（T37）
              attackerTypes: selectedAttacker.profile.types,
              defender: {
                weakness: selectedTarget.profile.weakness,
                resistance: selectedTarget.profile.resistance,
              },
              targetIsBench: selectedTarget.slot.slotId !== 'active',
              applyWeaknessToBench: applyToBench,
              useWeakness,
              useResistance,
              skipWeaknessResistance,
              ignoreTargetEffects,
              manualAdjustment,
            },
          ),
        )
      : null;
  const isCounterUnit = calculation ? calculation.finalDamage % 10 === 0 : false;

  const selectAttack = (nextIndex: number, attacker = selectedAttacker) => {
    setAttackIndex(nextIndex);
    setBaseDamage(suggestedBaseDamage(attacker?.card.attacks?.[nextIndex]?.damage ?? ''));
    setBaseConfirmed(false);
  };

  return (
    <aside className={styles.panel} aria-label="ダメージ計算">
      <header>
        <div>
          <span className={styles.eyebrow}>DAMAGE ASSIST</span>
          <h2>ダメージ計算</h2>
        </div>
        <button type="button" className={styles.close} onClick={onClose} aria-label="閉じる">×</button>
      </header>

      {!selectedAttacker || !selectedTarget || !selectedAttack ? (
        <p className={styles.empty}>ワザを持つポケモンと対象を場に用意してください。</p>
      ) : (
        <>
          <label className={styles.field}>
            <span>攻撃するポケモン</span>
            <select
              value={selectedAttacker.key}
              onChange={(event) => {
                const next = attackers.find((choice) => choice.key === event.target.value);
                setAttackerKey(event.target.value);
                selectAttack(0, next);
              }}
            >
              {attackers.map((choice) => (
                <option key={choice.key} value={choice.key}>
                  {choice.card.name}（{slotLabel(choice.slot)}）
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span>ワザ</span>
            <select value={attackIndex} onChange={(event) => selectAttack(Number(event.target.value))}>
              {attackList.map((attack, index) => (
                <option key={`${attack.name}-${index}`} value={index}>
                  {attack.name}　{attack.damage || '—'}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span>対象</span>
            <select
              value={selectedTarget.key}
              onChange={(event) => setTargetKey(event.target.value)}
            >
              {targets.map((choice) => (
                <option key={choice.key} value={choice.key}>
                  {state.players[choice.playerId]?.displayName}・{choice.card.name}（{slotLabel(choice.slot)}）
                </option>
              ))}
            </select>
          </label>

          <section className={styles.baseStep}>
            <div className={styles.stepTitle}>
              <span>1</span>
              基礎ダメージを人が確定
            </div>
            <p>カード表記: <strong>{selectedAttack.damage || 'なし'}</strong></p>
            <div className={styles.numberRow}>
              <input
                aria-label="基礎ダメージ"
                type="number"
                min="0"
                step="10"
                value={baseDamage}
                onChange={(event) => {
                  setBaseDamage(Math.max(0, Number(event.target.value) || 0));
                  setBaseConfirmed(false);
                }}
              />
              <button type="button" onClick={() => setBaseConfirmed(true)}>
                {baseConfirmed ? '確定済み ✓' : 'この値で確定'}
              </button>
            </div>
            <small>「120+」「60×」などの効果分は自動計算しません。</small>
          </section>

          <section className={styles.switches}>
            <label>
              <input
                type="checkbox"
                checked={useWeakness}
                onChange={(event) => setUseWeakness(event.target.checked)}
              />
              弱点を使う
            </label>
            <label>
              <input
                type="checkbox"
                checked={useResistance}
                onChange={(event) => setUseResistance(event.target.checked)}
              />
              抵抗力を使う
            </label>
            <label>
              <input
                type="checkbox"
                checked={skipWeaknessResistance}
                onChange={(event) => setSkipWeaknessResistance(event.target.checked)}
              />
              弱点・抵抗力を計算しない
              <small>ワザ本文の指定</small>
            </label>
            <label>
              <input
                type="checkbox"
                checked={ignoreTargetEffects}
                onChange={(event) => setIgnoreTargetEffects(event.target.checked)}
              />
              かかっている効果を計算しない
              <small>Step5 と「受けない」を無視</small>
            </label>
            {selectedTarget.slot.slotId !== 'active' && (
              <label>
                <input
                  type="checkbox"
                  checked={applyToBench}
                  onChange={(event) => setApplyToBench(event.target.checked)}
                />
                ベンチにも弱点・抵抗力を適用する
                <small>既定では計算しません</small>
              </label>
            )}
            <label className={styles.manual}>
              <span>手動調整</span>
              <input
                aria-label="手動調整"
                type="number"
                step="10"
                value={manualAdjustment}
                onChange={(event) => setManualAdjustment(Number(event.target.value) || 0)}
              />
            </label>
          </section>

          {/* 6段の内訳（§5.3）。数値だけ出さず「どこで何が起きたか」を追えるようにする */}
          <section
            className={`${styles.calculation} ${!baseConfirmed ? styles.unconfirmed : ''}`}
            aria-label="ダメージ計算の内訳"
          >
            <ol className={styles.steps}>
              {calculation?.steps.map((step) => (
                <li
                  key={step.step}
                  className={`${styles.step} ${step.applied ? styles.stepOn : styles.stepOff} ${
                    step.step === 6 ? styles.stepFinal : ''
                  }`}
                >
                  <span className={styles.stepNo}>{step.step}</span>
                  <span className={styles.stepLabel}>
                    {step.label}
                    {step.sources.length > 0 && (
                      <small className={styles.stepSources}>{step.sources.join(' / ')}</small>
                    )}
                  </span>
                  <span className={styles.stepDetail}>{step.detail}</span>
                  <span className={styles.stepValue}>{step.applied ? step.value : '—'}</span>
                </li>
              ))}
            </ol>

            {calculation?.stoppedAt != null && (
              <p className={styles.stopped}>
                Step{calculation.stoppedAt} で0以下になったので、そこで計算を打ち切りました。
              </p>
            )}

            <div className={styles.total}>
              <span>最終ダメージ</span>
              <strong>{calculation?.finalDamage ?? 0}</strong>
              <small>ダメカン {calculation?.damageCounters ?? 0}個</small>
            </div>
          </section>

          {!isCounterUnit && (
            <p className={styles.error}>ダメカンに変換するため、最終値を10単位にしてください。</p>
          )}
          <button
            type="button"
            className={styles.apply}
            disabled={!baseConfirmed || !calculation || !isCounterUnit}
            onClick={() => {
              if (!calculation) return;
              dispatch({
                type: 'useAttack',
                playerId: selectedAttacker.playerId,
                slotId: selectedAttacker.slot.slotId,
                attackIndex,
                attackName: selectedAttack.name,
                targetPlayerId: selectedTarget.playerId,
                targetSlotId: selectedTarget.slot.slotId,
              });
              dispatch({
                type: 'applyDamageCalculation',
                playerId: selectedTarget.playerId,
                slotId: selectedTarget.slot.slotId,
                expectedTopInstanceId: selectedTarget.topInstanceId,
                attackName: selectedAttack.name,
                baseDamage,
                weaknessApplied: calculation.steps[2]?.applied ?? false,
                resistanceApplied: calculation.steps[3]?.applied ?? false,
                manualAdjustment,
                finalDamage: calculation.finalDamage,
                damageCounters: calculation.damageCounters,
              });
              onClose();
            }}
          >
            確定してダメカンをのせる
          </button>
        </>
      )}
    </aside>
  );
}
