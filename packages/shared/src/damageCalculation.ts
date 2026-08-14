/**
 * ダメージ計算パイプライン（第3段階 §4.1 / T28）。
 *
 * 公式の6段を、順番も打ち切りもそのまま実装する:
 *
 *   Step1: 基本ダメージ（+ / × / − をここで適用） → 0以下なら終了
 *   Step2: 与える側にかかっている効果              → 0以下なら終了
 *   Step3: 弱点
 *   Step4: 抵抗力                                 → 0以下なら終了
 *   Step5: 受ける側にかかっている効果              → 0以下なら終了
 *   Step6: 確定。「ワザのダメージを受けない」ならここで0
 *
 * ★間違えやすいところ（指示書が名指ししている）:
 *
 *   1. `+`（Step1 のダメージ追加）と 「+●●される」（Step2 の効果）は **別物**。
 *      前者はワザの本文が書いている増分で、人が Step1 の値として確定させる。
 *      後者は場にかかっている効果で、Step2 で足す。
 *
 *   2. 効果が「与える側」「受ける側」のどちらにかかっているかで **適用段が変わる**。
 *      ActiveEffect.applyAt が step2 か step5 かで振り分ける。
 *
 *   3. 「弱点・抵抗力を計算しない」→ Step3,4 をスキップ。
 *
 *   4. 「かかっている効果を計算しない」→ **Step5 と「ワザのダメージを受けない」を無視**。
 *      ただし **弱点・抵抗力の増減効果は「かかっている効果」ではない** ので別扱い。
 *      （このファイルでは weaknessDelta / resistanceDelta として Step3,4 に入れてある。
 *        Step5 のスキップでは消えない）
 *
 *   5. ベンチへのダメージは、特別な指定がない限り弱点・抵抗力を計算しない。
 *
 *   6. ★**ダメカンを「のせる」のはダメージではない**。
 *      弱点・抵抗力・軽減効果を一切通さない。だから damageCounter オペコードは
 *      このパイプラインを **通さない**（interpreter.ts 側で直接のせる）。
 */
import { continuousDamageModifier, ignoresWeakness, topCardTextOf } from './derived';
import {
  damageModifierEffectsFor,
  damageModifierFor,
  describeEffect,
  preventsAttackDamage,
} from './effects';
import { attackDamageImmunity } from './lock';
import type { RuleContext } from './rules';
import type { CardText, EnergyType, GameState, PlayerId, SlotId } from './types';

export type DamageStepId = 1 | 2 | 3 | 4 | 5 | 6;

export interface DamageStepResult {
  step: DamageStepId;
  /** 画面に出す段の名前 */
  label: string;
  /** その段で何をしたか。'+30' '×2' '−20' '—' など */
  detail: string;
  /** その段を終えた時点の値 */
  value: number;
  applied: boolean;
  /** どの効果が効いたか。★数値だけ出さず、追えるようにする（§5.3） */
  sources: string[];
}

export interface DamagePipelineInput {
  /** Step1。ワザ本文の + / × / − を織り込んで **人が確定させた** 値 */
  baseDamage: number;
  attackerTypes: readonly EnergyType[];
  defender: Pick<CardText, 'weakness' | 'resistance'>;
  targetIsBench: boolean;

  /** Step2: 与える側にかかっている効果の合計 */
  attackerModifier?: number;
  attackerModifierSources?: readonly string[];
  /** Step5: 受ける側にかかっている効果の合計 */
  targetModifier?: number;
  targetModifierSources?: readonly string[];
  /** Step6: 受ける側に「ワザのダメージを受けない」がかかっているか */
  targetPreventsDamage?: boolean;

  /**
   * 弱点・抵抗力そのものを増減する効果。
   * ★これは「かかっている効果」ではないので ignoreTargetEffects では消えない。
   */
  weaknessDelta?: number;
  resistanceDelta?: number;

  /** ワザ本文「弱点・抵抗力を計算しない」 */
  skipWeaknessResistance?: boolean;
  /**
   * 弱点 **だけ** 計算しない（ウィークガードエネルギー。T33）。
   * ★抵抗力は残るので skipWeaknessResistance とは別に持つ。
   */
  ignoreWeakness?: boolean;
  /** ワザ本文「かかっている効果を計算しない」 */
  ignoreTargetEffects?: boolean;
  /** ベンチにも弱点・抵抗力を適用する明示指定 */
  applyWeaknessToBench?: boolean;

  /** 人が個別に弱点・抵抗力を切る（第2段階のアシストパネル由来） */
  useWeakness?: boolean;
  useResistance?: boolean;
  /** 自動化しきれないぶんを人が足す。★人の指定なので ignoreTargetEffects でも消さない */
  manualAdjustment?: number;
}

export interface DamagePipelineResult {
  steps: DamageStepResult[];
  finalDamage: number;
  /** 0以下になって打ち切った段。最後まで通れば null */
  stoppedAt: DamageStepId | null;
  /** ×10 でダメカンに直した数 */
  damageCounters: number;
}

// ── 弱点・抵抗力の表記を読む ───────────────

/** "×2" → 2。倍率表記でなければ null */
export function weaknessMultiplierOf(modifier: string | undefined): number | null {
  if (!modifier) return null;
  const match = modifier.match(/[×xX*]\s*(\d+(?:\.\d+)?)/u);
  return match ? Number(match[1]) : null;
}

/** "+30" "-20" → 30 / -20。加減表記でなければ null */
export function modifierAdjustmentOf(modifier: string | undefined): number | null {
  if (!modifier) return null;
  const normalized = modifier.replace(/[−ー]/gu, '-').replace(/[＋]/gu, '+');
  const match = normalized.match(/[+-]\s*\d+/u);
  return match ? Number(match[0].replace(/\s/gu, '')) : null;
}

/** "120+" や "60×" から入力欄の初期候補だけを取り出す。確定は必ず人が行う */
export function suggestedBaseDamage(printed: string): number {
  const match = printed.match(/\d+/u);
  return match ? Number(match[0]) : 0;
}

const signed = (n: number): string => `${n >= 0 ? '+' : '−'}${Math.abs(n)}`;

// ── 6段 ───────────────────────────────

export function runDamagePipeline(input: DamagePipelineInput): DamagePipelineResult {
  const steps: DamageStepResult[] = [];
  let stoppedAt: DamageStepId | null = null;

  const push = (
    step: DamageStepId,
    label: string,
    detail: string,
    value: number,
    applied: boolean,
    sources: readonly string[] = [],
  ): void => {
    steps.push({ step, label, detail, value, applied, sources: [...sources] });
  };

  // ── Step1: 基本ダメージ ──
  // ワザ本文の + / × / − はここまでに織り込まれている（人が確定させた値）
  let value = Math.max(0, Math.trunc(input.baseDamage));
  push(1, '基本ダメージ', String(value), value, true);
  if (value <= 0) {
    return finish(steps, 1, 0);
  }

  // ── Step2: 与える側にかかっている効果 ──
  const attackerModifier = Math.trunc(input.attackerModifier ?? 0);
  if (attackerModifier !== 0) {
    value = value + attackerModifier;
    push(2, '与える側の効果', signed(attackerModifier), Math.max(0, value), true,
      input.attackerModifierSources ?? []);
  } else {
    push(2, '与える側の効果', '—', value, false);
  }
  if (value <= 0) return finish(steps, 2, 0);

  // ── Step3 / Step4: 弱点・抵抗力 ──
  // ベンチは特別な指定がない限り計算しない。「計算しない」ワザなら両方とばす
  const weaknessAllowed =
    !input.skipWeaknessResistance && (!input.targetIsBench || Boolean(input.applyWeaknessToBench));

  const weakness = input.defender.weakness;
  const multiplier = weaknessMultiplierOf(weakness?.modifier);
  const weaknessAdd = multiplier === null ? modifierAdjustmentOf(weakness?.modifier) : null;
  const weaknessHits = Boolean(
    weaknessAllowed &&
      !input.ignoreWeakness &&
      (input.useWeakness ?? true) &&
      weakness &&
      input.attackerTypes.includes(weakness.type) &&
      (multiplier !== null || weaknessAdd !== null),
  );

  if (weaknessHits) {
    const before = value;
    value = multiplier !== null ? before * multiplier : before + (weaknessAdd ?? 0);
    // 弱点そのものを増減する効果（★「かかっている効果」ではない）
    const delta = Math.trunc(input.weaknessDelta ?? 0);
    value += delta;
    const detail =
      (multiplier !== null ? `×${multiplier}` : signed(weaknessAdd ?? 0)) +
      (delta !== 0 ? ` ${signed(delta)}` : '');
    push(3, `弱点 ${weakness?.type ?? ''}`, detail, value, true);
  } else {
    push(
      3,
      '弱点',
      input.skipWeaknessResistance || input.ignoreWeakness ? '計算しない' : '—',
      value,
      false,
    );
  }

  const resistance = input.defender.resistance;
  const resistanceAdjustment = modifierAdjustmentOf(resistance?.modifier);
  const resistanceHits = Boolean(
    weaknessAllowed &&
      (input.useResistance ?? true) &&
      resistance &&
      input.attackerTypes.includes(resistance.type) &&
      resistanceAdjustment !== null &&
      resistanceAdjustment !== 0,
  );

  if (resistanceHits) {
    const delta = Math.trunc(input.resistanceDelta ?? 0);
    value += (resistanceAdjustment ?? 0) + delta;
    const detail = signed(resistanceAdjustment ?? 0) + (delta !== 0 ? ` ${signed(delta)}` : '');
    push(4, `抵抗力 ${resistance?.type ?? ''}`, detail, Math.max(0, value), true);
  } else {
    push(4, '抵抗力', input.skipWeaknessResistance ? '計算しない' : '—', value, false);
  }
  if (value <= 0) return finish(steps, 4, 0);

  // ── Step5: 受ける側にかかっている効果 ──
  // 「かかっている効果を計算しない」ならここを丸ごととばす
  const targetModifier = input.ignoreTargetEffects ? 0 : Math.trunc(input.targetModifier ?? 0);
  // 手動調整は人の指定なので、効果を無視するワザでも残す
  const manual = Math.trunc(input.manualAdjustment ?? 0);
  const step5 = targetModifier + manual;

  if (step5 !== 0) {
    value += step5;
    const sources = [
      ...(input.ignoreTargetEffects ? [] : (input.targetModifierSources ?? [])),
      ...(manual !== 0 ? [`手動調整 ${signed(manual)}`] : []),
    ];
    push(5, '受ける側の効果', signed(step5), Math.max(0, value), true, sources);
  } else {
    push(5, '受ける側の効果', input.ignoreTargetEffects ? '計算しない' : '—', value, false);
  }
  if (value <= 0) return finish(steps, 5, 0);

  // ── Step6: 確定 ──
  const prevented = Boolean(input.targetPreventsDamage) && !input.ignoreTargetEffects;
  if (prevented) {
    push(6, '確定', 'ワザのダメージを受けない', 0, true, ['ワザのダメージを受けない']);
    return finish(steps, null, 0);
  }
  const finalDamage = Math.max(0, value);
  push(6, '確定', String(finalDamage), finalDamage, true);
  return finish(steps, null, finalDamage);

  function finish(
    all: DamageStepResult[],
    stopped: DamageStepId | null,
    final: number,
  ): DamagePipelineResult {
    stoppedAt = stopped;
    // 打ち切った段より後は「（打ち切り）」として並べる。§5.3 で追えるようにするため
    if (stopped !== null) {
      for (let s = stopped + 1; s <= 6; s += 1) {
        all.push({
          step: s as DamageStepId,
          label: LABELS[s as DamageStepId],
          detail: '（0以下で打ち切り）',
          value: 0,
          applied: false,
          sources: [],
        });
      }
    }
    return {
      steps: all,
      finalDamage: final,
      stoppedAt,
      damageCounters: Math.round(final / 10),
    };
  }
}

const LABELS: Record<DamageStepId, string> = {
  1: '基本ダメージ',
  2: '与える側の効果',
  3: '弱点',
  4: '抵抗力',
  5: '受ける側の効果',
  6: '確定',
};

// ── 盤面から入力を組み立てる（T26 との接続） ──

export interface DamageSlotRef {
  playerId: PlayerId;
  slotId: SlotId;
}

/**
 * かかっている効果を盤面から読んで、パイプラインの入力に流し込む。
 * ★与える側は Step2、受ける側は Step5。ここで振り分ける。
 */
export function damageInputFromState(
  state: GameState,
  ctx: RuleContext,
  attacker: DamageSlotRef,
  target: DamageSlotRef,
  rest: Omit<
    DamagePipelineInput,
    | 'attackerModifier'
    | 'attackerModifierSources'
    | 'targetModifier'
    | 'targetModifierSources'
    | 'targetPreventsDamage'
  >,
): DamagePipelineInput {
  // ★スロット単位・プレイヤー単位・全体、どれも同じ段に入る（T43）
  const targetIsActive = target.slotId === 'active';
  // ★「自分のフュージョンのポケモンが使うワザ」のように、効かせる側を絞る効果がある（T44）
  const attackerCard = topCardTextOf(state, attacker.playerId, attacker.slotId, ctx);
  const labelsOf = (ref: DamageSlotRef, applyAt: 'step2' | 'step5'): string[] =>
    damageModifierEffectsFor(
      state,
      ref.playerId,
      ref.slotId,
      applyAt,
      targetIsActive,
      ref === attacker ? attackerCard : undefined,
    ).map(describeEffect);

  /*
   * 足し合わせるのは2種類（T33）:
   *   1. かかっている効果（ActiveEffect）… 一度かかったら残る。state.effects が持つ
   *   2. 場のカードの常時効果            … どうぐ・スタジアム由来。派生状態で毎回計算する
   * どちらも同じ段（step2 / step5）に入る。
   */
  const continuous = (applyAt: 'step2' | 'step5') =>
    continuousDamageModifier(state, attacker, target, applyAt, ctx);
  const fromBoardStep2 = continuous('step2');
  const fromBoardStep5 = continuous('step5');

  return {
    ...rest,
    // ★ウィークガードエネルギーは **弱点だけ** を計算しない。抵抗力は残る（T33）
    ignoreWeakness:
      Boolean(rest.ignoreWeakness) || ignoresWeakness(state, target.playerId, target.slotId, ctx),
    attackerModifier:
      damageModifierFor(
        state,
        attacker.playerId,
        attacker.slotId,
        'step2',
        targetIsActive,
        attackerCard,
      ) + fromBoardStep2.delta,
    attackerModifierSources: [...labelsOf(attacker, 'step2'), ...fromBoardStep2.sources],
    targetModifier:
      damageModifierFor(state, target.playerId, target.slotId, 'step5') + fromBoardStep5.delta,
    targetModifierSources: [...labelsOf(target, 'step5'), ...fromBoardStep5.sources],
    /*
     * Step6「ワザのダメージを受けない」。2系統ある:
     *   1. かかっている効果（ActiveEffect）… ワザや効果でかかったもの
     *   2. ★場のロック宣言（ジュナイパー等。T42）… 攻撃側のカードを条件にする
     */
    targetPreventsDamage:
      preventsAttackDamage(state, target.playerId, target.slotId) ||
      attackDamageImmunity(state, target, attacker, ctx).locked,
  };
}

// ── 第2段階（T19）の呼び口。パイプラインに委譲する ──

export interface DamageCalculationInput {
  baseDamage: number;
  attackerTypes: readonly EnergyType[];
  defender: Pick<CardText, 'weakness' | 'resistance'>;
  targetIsBench: boolean;
  applyToBench: boolean;
  useWeakness: boolean;
  useResistance: boolean;
  manualAdjustment: number;
}

export interface DamageCalculationResult {
  baseDamage: number;
  weaknessApplied: boolean;
  weaknessMultiplier: number;
  afterWeakness: number;
  resistanceApplied: boolean;
  resistanceAdjustment: number;
  afterResistance: number;
  manualAdjustment: number;
  finalDamage: number;
}

/**
 * T19 のアシストパネルが使ってきた形。
 * 中身は6段パイプラインなので、結果は必ず一致する。
 */
export function calculateDamage(input: DamageCalculationInput): DamageCalculationResult {
  const result = runDamagePipeline({
    baseDamage: input.baseDamage,
    attackerTypes: input.attackerTypes,
    defender: input.defender,
    targetIsBench: input.targetIsBench,
    applyWeaknessToBench: input.applyToBench,
    useWeakness: input.useWeakness,
    useResistance: input.useResistance,
    manualAdjustment: input.manualAdjustment,
  });

  const step = (id: DamageStepId): DamageStepResult | undefined =>
    result.steps.find((s) => s.step === id);

  return {
    baseDamage: Math.max(0, Math.trunc(input.baseDamage)),
    weaknessApplied: step(3)?.applied ?? false,
    weaknessMultiplier: weaknessMultiplierOf(input.defender.weakness?.modifier) ?? 1,
    afterWeakness: step(3)?.value ?? 0,
    resistanceApplied: step(4)?.applied ?? false,
    resistanceAdjustment: modifierAdjustmentOf(input.defender.resistance?.modifier) ?? 0,
    afterResistance: step(4)?.value ?? 0,
    manualAdjustment: Math.trunc(input.manualAdjustment),
    finalDamage: result.finalDamage,
  };
}
