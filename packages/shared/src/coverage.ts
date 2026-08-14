/**
 * 自動化カバレッジの計測（第3段階 T35）。
 *
 * ★指示書 §1 の言い方に合わせて、**カードで数えず、オペコードで数える**。
 *   「何枚のカードを実装したか」ではなく
 *   「どのオペコードがどれだけ使い回されているか」「何が足りないか」を見る。
 *
 * 数える単位は3つ:
 *
 *   1. 効果の単位（unit）… トレーナーズ/エネルギーの本文1つ、特性1つ、ワザ1つ。
 *      ここが自動化率の分母になる。カード枚数を分母にすると、
 *      ワザを10個持つポケモンも1枚と数えてしまい実態がぼやける。
 *   2. オペコード     … 種類ごとの使用回数。使い回しの効率が見える。
 *   3. 未対応パターン … MANUAL の本文を正規化して頻度順に並べる。
 *      「次にどの言い回しを実装すれば一番効くか」がこれで決まる。
 *
 * ★このファイルは純粋関数だけ。ファイルの読み書きはサーバー側が行う。
 */
import { effectModeOf, type EffectMode, type Op, type OpCode } from './dsl';
import type { CardText } from './types';

// ── 効果の単位 ─────────────────────────

/** 数える対象の種類 */
export type UnitKind = 'trainer' | 'energy' | 'ability' | 'attack';

export interface CoverageUnit {
  functionalId: string;
  cardName: string;
  kind: UnitKind;
  /** 特性名・ワザ名。トレーナーズ本文なら null */
  label: string | null;
  mode: EffectMode;
  /** その単位の本文（未対応パターンの材料） */
  text: string;
  /** manual オペコードの文面（ASSISTED のとき） */
  manualPrompts: string[];
}

export interface PatternRow {
  pattern: string;
  count: number;
  /** 代表例（先に出てきたカード名を最大3件） */
  examples: string[];
}

export interface CoverageReport {
  cardCount: number;
  units: CoverageUnit[];
  /** 単位の種類ごとの内訳。ワザは第3段階の対象外なので分けて見る */
  byKind: Record<UnitKind, Record<EffectMode, number>>;
  /** ワザを除いた自動化率（0〜1） */
  automationRate: number;
  /** ワザを含めた自動化率（0〜1） */
  automationRateWithAttacks: number;
  /** オペコードの使用回数。多い順 */
  opcodeCounts: { op: OpCode; count: number }[];
  /** 一度も使っていないオペコード */
  unusedOpcodes: OpCode[];
  /** ASSISTED の逃げ道。文面ごとの件数 */
  manualPrompts: PatternRow[];
  /** ★未対応パターン 上位N件 */
  unsupportedPatterns: PatternRow[];
}

// ── 単位の切り出し ───────────────────────

/**
 * カード1枚から、数える単位を取り出す。
 *
 * ★常時効果（continuous）しか持たないカードは自動化済みとして数える。
 *   スカイフィールドやウソッキーは、実行するものが何もないのが正しい姿。
 */
export function unitsOf(card: CardText): CoverageUnit[] {
  const units: CoverageUnit[] = [];
  const base = { functionalId: card.functionalId, cardName: card.name };

  if (card.supertype === 'trainer' || card.supertype === 'energy') {
    const kind: UnitKind = card.supertype === 'trainer' ? 'trainer' : 'energy';
    const text = card.text ?? '';
    // 本文も常時効果も持たない基本エネルギーなどは、数える対象がない
    // ★ロック宣言（T42）も「実行するものがない自動化」なので同じ扱い
    const declaresContinuous =
      (card.continuous ?? []).length > 0 ||
      (card.locks ?? []).length > 0 ||
      card.energyValue !== undefined;
    if (text !== '' || card.effects || declaresContinuous) {
      units.push({
        ...base,
        kind,
        label: null,
        // 常時効果だけで表現できているものは AUTO 扱い（実行するものがない）
        mode: card.effects ? effectModeOf(card.effects) : declaresContinuous ? 'AUTO' : 'MANUAL',
        text,
        manualPrompts: card.effects ? manualPromptsOf(card.effects) : [],
      });
    }
  }

  for (const ability of card.abilities ?? []) {
    const declaresContinuous =
      (card.continuous ?? []).length > 0 || (card.locks ?? []).length > 0;
    units.push({
      ...base,
      kind: 'ability',
      label: ability.name,
      mode: ability.effects
        ? effectModeOf(ability.effects)
        : ability.trigger === 'passive' && declaresContinuous
          ? 'AUTO'
          : 'MANUAL',
      text: ability.text,
      manualPrompts: ability.effects ? manualPromptsOf(ability.effects) : [],
    });
  }

  for (const attack of card.attacks ?? []) {
    // ワザの効果DSLは第3段階の対象外（§1）。数えるが、率は分けて出す
    // ★T42 から、ワザに付随する効果（グッズロック等）は宣言できる
    units.push({
      ...base,
      kind: 'attack',
      label: attack.name,
      mode: attack.effects ? effectModeOf(attack.effects) : 'MANUAL',
      text: attack.text,
      manualPrompts: attack.effects ? manualPromptsOf(attack.effects) : [],
    });
  }

  return units;
}

/** ops の中の manual オペコードの文面を集める（if/repeat の中も見る） */
export function manualPromptsOf(ops: readonly Op[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly Op[]): void => {
    for (const op of list) {
      if (op.op === 'manual') out.push(op.prompt);
      else if (op.op === 'if') {
        walk(op.then);
        walk(op.else ?? []);
      } else if (op.op === 'repeat') walk(op.body);
    }
  };
  walk(ops);
  return out;
}

/** ops に出てくるオペコードを数える（if/repeat の中も数える） */
export function countOpcodes(ops: readonly Op[], into = new Map<OpCode, number>()): Map<OpCode, number> {
  for (const op of ops) {
    into.set(op.op, (into.get(op.op) ?? 0) + 1);
    if (op.op === 'if') {
      countOpcodes(op.then, into);
      countOpcodes(op.else ?? [], into);
    } else if (op.op === 'repeat') countOpcodes(op.body, into);
  }
  return into;
}

// ── 未対応パターンの正規化 ─────────────────

/**
 * 本文を「言い回しの型」に潰す。
 *
 * ★数とカード名を伏せ字にすると、同じ処理をしているカードが1つに集まる。
 *   「山札を7枚引く」「山札を6枚引く」→「山札を▲枚引く」
 *
 * 完璧な自然言語処理はしない。頻度の高い言い回しが浮かべば十分（§7-2）。
 */
export function normalizePattern(sentence: string): string {
  return sentence
    .replace(/[0-9０-９]+/gu, '▲')
    .replace(/「[^」]*」/gu, '●')
    .replace(/[《〈][^》〉]*[》〉]/gu, '●')
    .replace(/\s+/gu, '')
    .trim();
}

/** 本文を文に割る。「。」区切り。空文は捨てる */
export function sentencesOf(text: string): string[] {
  return text
    .split(/[。\n]/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}

function tally(
  entries: readonly { key: string; example: string }[],
  limit: number,
): PatternRow[] {
  const counts = new Map<string, { count: number; examples: string[] }>();
  for (const { key, example } of entries) {
    const found = counts.get(key) ?? { count: 0, examples: [] };
    found.count += 1;
    if (found.examples.length < 3 && !found.examples.includes(example)) {
      found.examples.push(example);
    }
    counts.set(key, found);
  }
  return [...counts]
    .map(([pattern, { count, examples }]) => ({ pattern, count, examples }))
    .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern))
    .slice(0, limit);
}

// ── 集計 ──────────────────────────────

const EMPTY_MODES = (): Record<EffectMode, number> => ({ AUTO: 0, ASSISTED: 0, MANUAL: 0 });

export function analyzeCoverage(
  cards: readonly CardText[],
  options: { topPatterns?: number; allOpcodes?: readonly OpCode[] } = {},
): CoverageReport {
  const topPatterns = options.topPatterns ?? 20;
  const units = cards.flatMap(unitsOf);

  const byKind: Record<UnitKind, Record<EffectMode, number>> = {
    trainer: EMPTY_MODES(),
    energy: EMPTY_MODES(),
    ability: EMPTY_MODES(),
    attack: EMPTY_MODES(),
  };
  for (const unit of units) byKind[unit.kind][unit.mode] += 1;

  // ワザは第3段階の対象外なので、率は分けて出す
  const scored = units.filter((unit) => unit.kind !== 'attack');
  const automated = (list: readonly CoverageUnit[]): number =>
    list.filter((unit) => unit.mode !== 'MANUAL').length;

  const opcodes = new Map<OpCode, number>();
  for (const card of cards) {
    if (card.effects) countOpcodes(card.effects, opcodes);
    for (const ability of card.abilities ?? []) {
      if (ability.effects) countOpcodes(ability.effects, opcodes);
    }
    // ★ワザに付随する効果（T42）も同じオペコードを使い回している
    for (const attack of card.attacks ?? []) {
      if (attack.effects) countOpcodes(attack.effects, opcodes);
    }
  }

  const manualEntries = units.flatMap((unit) =>
    unit.manualPrompts.map((prompt) => ({ key: prompt, example: unit.cardName })),
  );

  // ★未対応パターン: MANUAL の本文を文単位で正規化して数える
  const unsupportedEntries = scored
    .filter((unit) => unit.mode === 'MANUAL')
    .flatMap((unit) =>
      sentencesOf(unit.text).map((sentence) => ({
        key: normalizePattern(sentence),
        example: unit.label ? `${unit.cardName}「${unit.label}」` : unit.cardName,
      })),
    )
    .filter((entry) => entry.key.length > 0);

  const usedOpcodes = new Set(opcodes.keys());

  return {
    cardCount: cards.length,
    units,
    byKind,
    automationRate: scored.length === 0 ? 1 : automated(scored) / scored.length,
    automationRateWithAttacks: units.length === 0 ? 1 : automated(units) / units.length,
    opcodeCounts: [...opcodes]
      .map(([op, count]) => ({ op, count }))
      .sort((a, b) => b.count - a.count || a.op.localeCompare(b.op)),
    unusedOpcodes: (options.allOpcodes ?? []).filter((op) => !usedOpcodes.has(op)),
    manualPrompts: tally(manualEntries, topPatterns),
    unsupportedPatterns: tally(unsupportedEntries, topPatterns),
  };
}

// ── 画面に出す ──────────────────────────

const KIND_LABEL: Record<UnitKind, string> = {
  trainer: 'トレーナーズ',
  energy: 'エネルギー',
  ability: '特性',
  attack: 'ワザ',
};

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

const bar = (value: number, width = 24): string => {
  const filled = Math.round(value * width);
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
};

/** 端末での見た目の幅。日本語は2桁ぶん取る */
export const displayWidth = (text: string): number =>
  [...text].reduce((sum, ch) => sum + (/[ -~｡-ﾟ]/u.test(ch) ? 1 : 2), 0);

/** 見た目の幅をそろえて右側を空ける */
const padRight = (text: string, width: number): string =>
  text + ' '.repeat(Math.max(0, width - displayWidth(text)));

/** そのまま端末に出せる日本語のレポート */
export function formatCoverageReport(report: CoverageReport): string {
  const lines: string[] = [];
  const scored = report.units.filter((u) => u.kind !== 'attack');

  lines.push('══ カード自動化カバレッジ（T35） ══');
  lines.push('');
  lines.push(`カード ${report.cardCount}枚 / 効果の単位 ${report.units.length}件`);
  lines.push('');
  lines.push(`自動化率（ワザを除く）  ${bar(report.automationRate)} ${percent(report.automationRate)}`);
  lines.push(
    `  AUTO ${scored.filter((u) => u.mode === 'AUTO').length}件 / ` +
      `ASSISTED ${scored.filter((u) => u.mode === 'ASSISTED').length}件 / ` +
      `MANUAL ${scored.filter((u) => u.mode === 'MANUAL').length}件`,
  );
  lines.push(
    `自動化率（ワザを含む）  ${bar(report.automationRateWithAttacks)} ${percent(
      report.automationRateWithAttacks,
    )}`,
  );
  lines.push('  ※ワザの効果は第3段階の対象外（§1）。参考値');
  lines.push('');

  lines.push('── 単位の種類ごと ──');
  lines.push(`  ${padRight('種類', 16)}${'AUTO'.padStart(6)}${'ASSIST'.padStart(8)}${'MANUAL'.padStart(8)}`);
  for (const kind of ['trainer', 'energy', 'ability', 'attack'] as const) {
    const row = report.byKind[kind];
    if (row.AUTO + row.ASSISTED + row.MANUAL === 0) continue;
    lines.push(
      `  ${padRight(KIND_LABEL[kind], 16)}${String(row.AUTO).padStart(6)}` +
        `${String(row.ASSISTED).padStart(8)}${String(row.MANUAL).padStart(8)}`,
    );
  }
  lines.push('');

  lines.push('── オペコードの使用回数（★カードではなくオペコードで数える） ──');
  if (report.opcodeCounts.length === 0) lines.push('  （まだ1つも使われていません）');
  for (const { op, count } of report.opcodeCounts) {
    lines.push(`  ${op.padEnd(16)}${String(count).padStart(4)}回`);
  }
  if (report.unusedOpcodes.length > 0) {
    lines.push(`  未使用: ${report.unusedOpcodes.join(' / ')}`);
  }
  lines.push('');

  if (report.manualPrompts.length > 0) {
    lines.push('── ASSISTED の逃げ道（人に投げている場面） ──');
    for (const row of report.manualPrompts) {
      lines.push(`  ${String(row.count).padStart(3)}件  ${row.pattern}`);
      lines.push(`        ${row.examples.join(' / ')}`);
    }
    lines.push('');
  }

  lines.push(`── ★未対応パターン 上位${report.unsupportedPatterns.length}件 ──`);
  lines.push('   次にどの言い回しを実装すれば一番効くか');
  if (report.unsupportedPatterns.length === 0) {
    lines.push('  （未対応なし）');
  }
  for (const row of report.unsupportedPatterns) {
    lines.push(`  ${String(row.count).padStart(3)}件  ${row.pattern}`);
    lines.push(`        ${row.examples.join(' / ')}`);
  }

  return lines.join('\n');
}
