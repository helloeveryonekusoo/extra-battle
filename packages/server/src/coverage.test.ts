/**
 * T35: 実データ（data/cards/）に対してカバレッジが測れること。
 *
 * ★数値そのものは固定しない。カードを足すたびに落ちるテストは邪魔なだけ。
 *   「測れること」と「第3段階で作った4つの束が自動化されていること」だけを見る。
 */
import { describe, expect, it } from 'vitest';
import { analyzeCoverage, OP_CODES, type CoverageReport } from '@pokeca/shared';
import { loadCardTexts } from './cardStore';
import { runCoverage } from './writeCoverage';

const pool = loadCardTexts();
const report: CoverageReport = analyzeCoverage(pool, { topPatterns: 20, allOpcodes: OP_CODES });

const unitsOfCard = (name: string) =>
  report.units.filter((unit) => unit.cardName === name && unit.kind !== 'attack');

describe('T35 カバレッジ計測', () => {
  it('カードを読んで単位に分解できる', () => {
    expect(report.cardCount).toBe(pool.length);
    expect(report.units.length).toBeGreaterThan(report.cardCount / 2);
  });

  it('★自動化率が出る（0〜1）', () => {
    expect(report.automationRate).toBeGreaterThan(0);
    expect(report.automationRate).toBeLessThanOrEqual(1);
    expect(report.automationRateWithAttacks).toBeLessThanOrEqual(report.automationRate);
  });

  it('★未対応パターンが多い順に、最大20件出る', () => {
    expect(report.unsupportedPatterns.length).toBeLessThanOrEqual(20);
    const counts = report.unsupportedPatterns.map((row) => row.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    for (const row of report.unsupportedPatterns) expect(row.examples.length).toBeGreaterThan(0);
  });

  it('★オペコードの使用回数が多い順に出る（カードではなくオペコードで数える）', () => {
    const counts = report.opcodeCounts.map((row) => row.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    // search / draw は汎用トレーナーズの土台なので必ず使われている（§3.1）
    expect(report.opcodeCounts.find((row) => row.op === 'search')?.count).toBeGreaterThan(10);
    expect(report.opcodeCounts.find((row) => row.op === 'draw')?.count).toBeGreaterThan(5);
  });

  it('★T31〜T34 で実装したカードは MANUAL に残っていない', () => {
    const implemented = [
      'クイックボール', 'N', 'ふしぎなアメ', 'カリン', // T31
      'バトルコンプレッサー', 'バトルサーチャー', 'グズマ', 'ポケモンレンジャー', // T32
      'ダブル無色エネルギー', 'スカイフィールド', 'ふうせん', '森の封印石', // T33
      'クロバットV', 'デデンネGX', 'ダストダス', 'ウソッキー', // T34
    ];
    for (const name of implemented) {
      const units = unitsOfCard(name);
      expect(units.length, name).toBeGreaterThan(0);
      expect(
        units.every((unit) => unit.mode !== 'MANUAL'),
        `${name}: ${units.map((u) => `${u.label ?? '本文'}=${u.mode}`).join(' / ')}`,
      ).toBe(true);
    }
  });

  it('★逃げ道を使ったカードは ASSISTED として見える', () => {
    expect(unitsOfCard('ミュウ').map((u) => u.mode)).toContain('ASSISTED');
    expect(report.manualPrompts.length).toBeGreaterThan(0);
  });
});

describe('pnpm coverage の出力', () => {
  it('端末向けのレポートが出る', () => {
    const text = runCoverage([]);
    expect(text).toContain('カード自動化カバレッジ');
    expect(text).toContain('自動化率（ワザを除く）');
    expect(text).toMatch(/未対応パターン 上位\d+件/u);
  });

  it('--json で機械が読める形になる（units は落とす）', () => {
    const json = JSON.parse(runCoverage(['--json'])) as Record<string, unknown>;
    expect(json['automationRate']).toBeTypeOf('number');
    expect(json['unsupportedPatterns']).toBeInstanceOf(Array);
    expect(json['units']).toBeUndefined();
  });
});
