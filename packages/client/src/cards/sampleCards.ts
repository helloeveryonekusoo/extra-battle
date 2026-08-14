/**
 * 開発・テスト専用のカードプール（盤面デモと各テストだけが使う）。
 *
 * ★アプリの画面はこれを使わない。
 *   対戦中は接続先ごとに決まる（同じネットワーク＝サーバー / オンライン＝自分の端末のプール）。
 *   デッキ構築・カード見本は実行時プール（`cardPool.ts`）。
 *
 * ★ファイル名を1枚ずつ書かない（第5段階 T50）。
 *   `data/cards/` は .gitignore なので、公開ビルドの環境には1枚も無い。
 *   名指しで import すると **カードデータの無い環境でビルドが落ちる**。
 *   glob なら、無ければ空の索引になるだけで済む。
 */
import { buildCardIndex, parseCardTexts, type CardIndex, type CardText } from '@pokeca/shared';

const modules = import.meta.glob('../../../../data/cards/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

// ファイル名順に読む（同じ functionalId は後勝ちなので、並びを決めておく）
const all: CardText[] = Object.keys(modules)
  .sort()
  .flatMap((path) => parseCardTexts(modules[path]));

export const sampleCardIndex: CardIndex = buildCardIndex(all);
