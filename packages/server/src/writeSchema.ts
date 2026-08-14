/**
 * 効果DSL の JSON Schema をファイルに書き出す（T23）。
 *
 *   pnpm schema
 *
 * 出力した `data/schema/effects.schema.json` は標準の JSON Schema なので、
 * カード定義ファイルの先頭に `"$schema"` として書けば、
 * VS Code などのエディタがそのまま補完・検証してくれる。
 *
 * ★スキーマの実体は @pokeca/shared の buildEffectsJsonSchema。
 *   ここはファイルに落とすだけで、内容は一切持たない。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEffectsJsonSchema } from '@pokeca/shared';

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = resolve(here, '../../../data/schema/effects.schema.json');

export function writeEffectsSchema(path: string = SCHEMA_PATH): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(buildEffectsJsonSchema(), null, 2)}\n`, 'utf8');
  return path;
}

writeEffectsSchema();
console.log(`効果DSL の JSON Schema を書き出しました: ${SCHEMA_PATH}`);
