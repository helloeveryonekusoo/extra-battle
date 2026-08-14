/**
 * ディスク上のカードデータを読む唯一の場所。
 * 検証ロジックは @pokeca/shared に置き、ここは fs だけを担当する。
 *
 * 絶対制約: 外部サイトからの取得は行わない。ローカルの JSON を読むだけ。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildCardIndex, parseCardTexts, type CardIndex, type CardText } from '@pokeca/shared';

const here = dirname(fileURLToPath(import.meta.url));

/** リポジトリルートの data/cards/ */
export const CARD_DATA_DIR = resolve(here, '../../../data/cards');
export const SAMPLE_CARD_PATH = resolve(CARD_DATA_DIR, 'sample.json');
export const T31_CARD_PATH = resolve(CARD_DATA_DIR, 't31.json');
export const T32_CARD_PATH = resolve(CARD_DATA_DIR, 't32.json');
export const T33_CARD_PATH = resolve(CARD_DATA_DIR, 't33.json');
export const T34_CARD_PATH = resolve(CARD_DATA_DIR, 't34.json');
export const T42_CARD_PATH = resolve(CARD_DATA_DIR, 't42.json');
export const T43_KOKUBA_CARD_PATH = resolve(CARD_DATA_DIR, 't43-kokuba.json');
export const T43_PALKIA_CARD_PATH = resolve(CARD_DATA_DIR, 't43-palkia.json');
export const T43_REGIDRAGO_CARD_PATH = resolve(CARD_DATA_DIR, 't43-regidrago.json');
export const T43_ADP_CARD_PATH = resolve(CARD_DATA_DIR, 't43-adp.json');
export const T44_CARD_PATH = resolve(CARD_DATA_DIR, 't44.json');

export function loadCardTexts(filePath: string = SAMPLE_CARD_PATH): CardText[] {
  const raw = readFileSync(filePath, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`${filePath} が JSON として読めません`, { cause });
  }
  const cards = parseCardTexts(json);
  if (filePath !== SAMPLE_CARD_PATH) return cards;
  const t31 = JSON.parse(readFileSync(T31_CARD_PATH, 'utf8')) as unknown;
  const t32 = JSON.parse(readFileSync(T32_CARD_PATH, 'utf8')) as unknown;
  const t33 = JSON.parse(readFileSync(T33_CARD_PATH, 'utf8')) as unknown;
  const t34 = JSON.parse(readFileSync(T34_CARD_PATH, 'utf8')) as unknown;
  const t42 = JSON.parse(readFileSync(T42_CARD_PATH, 'utf8')) as unknown;
  // ★T43 は環境デッキを1つずつ足していく（デッキ単位で完成させる）
  const kokuba = JSON.parse(readFileSync(T43_KOKUBA_CARD_PATH, 'utf8')) as unknown;
  const palkia = JSON.parse(readFileSync(T43_PALKIA_CARD_PATH, 'utf8')) as unknown;
  const regidrago = JSON.parse(readFileSync(T43_REGIDRAGO_CARD_PATH, 'utf8')) as unknown;
  const adp = JSON.parse(readFileSync(T43_ADP_CARD_PATH, 'utf8')) as unknown;
  const t44 = JSON.parse(readFileSync(T44_CARD_PATH, 'utf8')) as unknown;
  return [
    ...cards,
    ...parseCardTexts(t31),
    ...parseCardTexts(t32),
    ...parseCardTexts(t33),
    ...parseCardTexts(t34),
    ...parseCardTexts(t42),
    ...parseCardTexts(kokuba),
    ...parseCardTexts(palkia),
    ...parseCardTexts(regidrago),
    ...parseCardTexts(adp),
    ...parseCardTexts(t44),
  ];
}

export function loadCardIndex(filePath: string = SAMPLE_CARD_PATH): CardIndex {
  return buildCardIndex(loadCardTexts(filePath));
}
