/**
 * 自動化カバレッジを測って表示する（T35）。
 *
 *   pnpm coverage           … 端末にレポートを出す
 *   pnpm coverage --json    … 機械で読む形（JSON）で出す
 *
 * ★集計そのものは @pokeca/shared の analyzeCoverage。
 *   ここはカードデータを読んで渡すだけで、判断は一切持たない。
 *
 * ★カードデータはリポジトリに含めない（絶対制約2）。
 *   data/cards/ を読むだけで、結果もファイルには書き出さない。
 */
import { argv } from 'node:process';
import { analyzeCoverage, formatCoverageReport, OP_CODES } from '@pokeca/shared';
import { loadCardTexts } from './cardStore';

export function runCoverage(args: readonly string[] = []): string {
  const cards = loadCardTexts();
  const report = analyzeCoverage(cards, { topPatterns: 20, allOpcodes: OP_CODES });
  if (args.includes('--json')) {
    // units は件数が多いので落とす。集計結果だけ出す
    const { units: _units, ...summary } = report;
    return JSON.stringify(summary, null, 2);
  }
  return formatCoverageReport(report);
}

// ★テストから import したときに勝手に出力しないよう、直接実行のときだけ動かす
if (argv[1]?.replace(/\\/gu, '/').endsWith('/writeCoverage.ts')) {
  console.log(runCoverage(argv.slice(2)));
}
