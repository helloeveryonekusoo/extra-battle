/**
 * T35 の完了条件:
 *   `pnpm coverage` で **自動化率** と **未対応パターン上位20件** が出せること。
 *
 * ★ここでは集計そのもの（純粋関数）を確かめる。
 *   実データを読む部分は server/src/coverage.test.ts。
 */
import { describe, expect, it } from 'vitest';
import {
  analyzeCoverage,
  countOpcodes,
  displayWidth,
  formatCoverageReport,
  manualPromptsOf,
  normalizePattern,
  sentencesOf,
  unitsOf,
} from './coverage';
import { OP_CODES, type Op } from './dsl';
import type { CardText } from './types';

// ── 材料 ────────────────────────────

const item = (over: Partial<CardText> & Pick<CardText, 'functionalId' | 'name'>): CardText => ({
  supertype: 'trainer',
  trainerKind: 'item',
  text: 'テスト',
  ...over,
});

const AUTO_ITEM = item({
  functionalId: 'c-auto',
  name: '自動グッズ',
  text: '自分の山札を3枚引く。',
  effects: [{ op: 'draw', player: 'self', count: 3 }],
});

const ASSISTED_ITEM = item({
  functionalId: 'c-assisted',
  name: '半自動グッズ',
  text: '相手のポケモンを1匹選ぶ。',
  effects: [
    { op: 'draw', player: 'self', count: 1 },
    { op: 'manual', prompt: '相手のポケモンを1匹えらんでください' },
  ],
});

const MANUAL_ITEM = item({
  functionalId: 'c-manual',
  name: '手動グッズ',
  text: '自分の山札を7枚引く。その山札を切る。',
});

const STADIUM = item({
  functionalId: 'c-stadium',
  name: '常時スタジアム',
  trainerKind: 'stadium',
  text: 'おたがいのベンチは8匹。',
  continuous: [{ kind: 'benchLimit', scope: 'all', limit: 8 }],
});

const POKEMON: CardText = {
  functionalId: 'c-mon',
  name: 'テストポケモン',
  supertype: 'pokemon',
  hp: 100,
  types: ['water'],
  stage: 'basic',
  ruleBox: null,
  weakness: null,
  resistance: null,
  retreatCost: 1,
  abilities: [
    {
      name: '自動特性',
      kind: 'ability',
      text: '自分の山札を1枚引く。',
      effects: [{ op: 'draw', player: 'self', count: 1 }],
    },
    { name: '手動特性', kind: 'ability', text: '相手の特性をすべてなくす。' },
  ],
  attacks: [{ name: 'たいあたり', cost: ['colorless'], damage: '20', text: '' }],
};

const BASIC_ENERGY: CardText = {
  functionalId: 'c-energy',
  name: '基本水エネルギー',
  supertype: 'energy',
  isBasicEnergy: true,
  energyProvides: ['water'],
};

const POOL = [AUTO_ITEM, ASSISTED_ITEM, MANUAL_ITEM, STADIUM, POKEMON, BASIC_ENERGY];

// ── 単位の切り出し ───────────────────

describe('効果の単位を取り出す', () => {
  it('トレーナーズは本文1つが1単位', () => {
    const units = unitsOf(AUTO_ITEM);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ kind: 'trainer', mode: 'AUTO', label: null });
  });

  it('manual を含めば ASSISTED、定義がなければ MANUAL', () => {
    expect(unitsOf(ASSISTED_ITEM)[0]?.mode).toBe('ASSISTED');
    expect(unitsOf(MANUAL_ITEM)[0]?.mode).toBe('MANUAL');
  });

  it('★常時効果だけで表せているカードは AUTO（実行するものがないのが正しい姿）', () => {
    expect(unitsOf(STADIUM)[0]?.mode).toBe('AUTO');
  });

  it('ポケモンは特性ごと・ワザごとに1単位', () => {
    const units = unitsOf(POKEMON);
    expect(units.map((u) => [u.kind, u.label, u.mode])).toEqual([
      ['ability', '自動特性', 'AUTO'],
      ['ability', '手動特性', 'MANUAL'],
      ['attack', 'たいあたり', 'MANUAL'],
    ]);
  });

  it('本文も効果も持たない基本エネルギーは数えない', () => {
    expect(unitsOf(BASIC_ENERGY)).toHaveLength(0);
  });
});

// ── オペコードで数える ────────────────

describe('★カードではなくオペコードで数える', () => {
  it('if / repeat の中のオペコードも数える', () => {
    const ops: Op[] = [
      { op: 'draw', player: 'self', count: 1 },
      {
        op: 'if',
        cond: { kind: 'exists', slot: { kind: 'self' } },
        then: [{ op: 'draw', player: 'self', count: 1 }],
        else: [{ op: 'shuffle', zone: 'deck', owner: 'self' }],
      },
      { op: 'repeat', times: 2, body: [{ op: 'draw', player: 'self', count: 1 }] },
    ];
    expect(Object.fromEntries(countOpcodes(ops))).toEqual({
      draw: 3,
      if: 1,
      shuffle: 1,
      repeat: 1,
    });
  });

  it('manual の文面も、枝の中まで集める', () => {
    const ops: Op[] = [
      {
        op: 'if',
        cond: { kind: 'exists', slot: { kind: 'self' } },
        then: [{ op: 'manual', prompt: '内側' }],
      },
      { op: 'manual', prompt: '外側' },
    ];
    expect(manualPromptsOf(ops)).toEqual(['内側', '外側']);
  });

  it('使っていないオペコードを教えてくれる', () => {
    const report = analyzeCoverage(POOL, { allOpcodes: OP_CODES });
    expect(report.opcodeCounts.find((row) => row.op === 'draw')?.count).toBe(3);
    expect(report.unusedOpcodes).toContain('heal');
    expect(report.unusedOpcodes).not.toContain('draw');
  });
});

// ── ★未対応パターン ─────────────────

describe('★未対応パターンの正規化', () => {
  it('数とかぎかっこを伏せ字にして、同じ言い回しをまとめる', () => {
    expect(normalizePattern('自分の山札を7枚引く')).toBe('自分の山札を▲枚引く');
    expect(normalizePattern('自分の山札を６枚引く')).toBe('自分の山札を▲枚引く');
    expect(normalizePattern('このポケモンの最大HPは「50」ふえる')).toBe('このポケモンの最大HPは●ふえる');
  });

  it('本文は「。」で文に割る。短すぎる断片は捨てる', () => {
    expect(sentencesOf('山札を7枚引く。その山札を切る。')).toEqual(['山札を7枚引く', 'その山札を切る']);
    expect(sentencesOf('。。あ。')).toEqual([]);
  });

  it('★同じ言い回しは1件にまとまり、件数の多い順に並ぶ', () => {
    const cards = [
      item({ functionalId: 'a', name: 'A', text: '自分の山札を7枚引く。' }),
      item({ functionalId: 'b', name: 'B', text: '自分の山札を6枚引く。' }),
      item({ functionalId: 'c', name: 'C', text: 'ベンチポケモンをすべて回復する。' }),
    ];
    const report = analyzeCoverage(cards);
    expect(report.unsupportedPatterns[0]).toMatchObject({
      pattern: '自分の山札を▲枚引く',
      count: 2,
      examples: ['A', 'B'],
    });
  });

  it('上位N件だけ返す', () => {
    const cards = Array.from({ length: 30 }, (_, i) =>
      item({ functionalId: `x-${i}`, name: `X${i}`, text: `パターン${String.fromCharCode(65 + i)}を実行する。` }),
    );
    expect(analyzeCoverage(cards, { topPatterns: 20 }).unsupportedPatterns).toHaveLength(20);
  });

  it('自動化できている単位は未対応パターンに出てこない', () => {
    const report = analyzeCoverage(POOL);
    const patterns = report.unsupportedPatterns.map((row) => row.pattern);
    expect(patterns).toContain('自分の山札を▲枚引く'); // 手動グッズ由来
    expect(report.unsupportedPatterns.every((row) => !row.examples.includes('自動グッズ'))).toBe(true);
  });
});

// ── 自動化率 ────────────────────────

describe('★自動化率', () => {
  const report = analyzeCoverage(POOL, { allOpcodes: OP_CODES });

  it('ワザを除いた率が主の指標（第3段階の対象はトレーナーズと特性）', () => {
    // 単位5件（グッズ3 + スタジアム1 + 特性2 = 6）のうち MANUAL は 手動グッズ と 手動特性 の2件
    const scored = report.units.filter((u) => u.kind !== 'attack');
    expect(scored).toHaveLength(6);
    expect(report.automationRate).toBeCloseTo(4 / 6, 5);
  });

  it('ワザを含めた率は別に出す（参考値）', () => {
    expect(report.automationRateWithAttacks).toBeCloseTo(4 / 7, 5);
    expect(report.byKind.attack.MANUAL).toBe(1);
  });

  it('ASSISTED は自動化できている側に数える（一部でも動くため）', () => {
    expect(report.byKind.trainer).toEqual({ AUTO: 2, ASSISTED: 1, MANUAL: 1 });
  });

  it('カードが1枚もなければ率は1（0除算しない）', () => {
    const empty = analyzeCoverage([]);
    expect(empty.automationRate).toBe(1);
    expect(empty.unsupportedPatterns).toEqual([]);
  });
});

// ── 表示 ────────────────────────────

describe('レポートの体裁', () => {
  const text = formatCoverageReport(analyzeCoverage(POOL, { allOpcodes: OP_CODES }));

  it('自動化率・オペコード・未対応パターンの3つが出る', () => {
    expect(text).toContain('自動化率（ワザを除く）');
    expect(text).toContain('オペコードの使用回数');
    expect(text).toContain('未対応パターン');
  });

  it('ASSISTED の逃げ道の文面が読める', () => {
    expect(text).toContain('相手のポケモンを1匹えらんでください');
  });

  it('日本語の幅をそろえて桁が崩れない', () => {
    expect(displayWidth('トレーナーズ')).toBe(12);
    expect(displayWidth('search')).toBe(6);
    const rows = text.split('\n').filter((line) => /^  (トレーナーズ|エネルギー|特性|ワザ)/u.test(line));
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((line) => displayWidth(line))).size).toBe(1);
  });
});
