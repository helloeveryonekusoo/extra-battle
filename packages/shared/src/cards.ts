/**
 * カードデータのローダーと索引（T3）。
 *
 * このファイルは fs を触らない。実際のファイル読み込みはサーバー側が行い、
 * ここは「渡された JSON を CardText[] として検証し、索引を作る」ことだけを担当する。
 * （クライアントからも同じ関数を使えるようにするため）
 *
 * 絶対制約: 画像URL・フレーバーテキストは扱わない。存在したら検証エラーにする。
 */
import type {
  Ability,
  Attack,
  CardText,
  NameAliasTable,
} from './types';
import { parseOps } from './dslSchema';
import {
  ABILITY_KINDS,
  ENERGY_TYPES,
  RULE_BOXES,
  STAGES,
  TRAINER_KINDS,
} from './cardVocabulary';

export { ABILITY_KINDS, ENERGY_TYPES, RULE_BOXES, STAGES, TRAINER_KINDS } from './cardVocabulary';

/** 絶対制約に反するキー。データに現れたら読み込みを失敗させる */
const FORBIDDEN_KEYS = ['image', 'imageUrl', 'images', 'imageUrlHiRes', 'flavorText', 'flavor'];

export class CardDataError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`カードデータが不正です:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'CardDataError';
    this.issues = issues;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): v is T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v);

function checkAttack(raw: unknown, where: string, issues: string[]): Attack | undefined {
  if (!isRecord(raw)) {
    issues.push(`${where}: ワザがオブジェクトではありません`);
    return undefined;
  }
  if (typeof raw['name'] !== 'string' || raw['name'] === '') {
    issues.push(`${where}: ワザ名がありません`);
  }
  if (typeof raw['damage'] !== 'string') {
    issues.push(`${where}: damage は文字列で持ちます（"120" "120+" "60×" "" など原文のまま）`);
  }
  if (typeof raw['text'] !== 'string') {
    issues.push(`${where}: text がありません（効果がないワザは空文字にする）`);
  }
  // T36: GXワザ / VSTARワザ は対戦中1回
  if (raw['oncePerGame'] !== undefined && !oneOf(raw['oncePerGame'], ONCE_PER_GAME_KINDS)) {
    issues.push(`${where}: oncePerGame は ${ONCE_PER_GAME_KINDS.join(' / ')} のいずれかです`);
  }
  // T41: 追加の番
  if (raw['extraTurn'] !== undefined && typeof raw['extraTurn'] !== 'boolean') {
    issues.push(`${where}: extraTurn は true/false です`);
  }
  const cost = raw['cost'];
  if (!Array.isArray(cost) || cost.some((c) => !oneOf(c, ENERGY_TYPES))) {
    issues.push(`${where}: cost はエネルギータイプの配列にしてください`);
  }
  // T42: ワザに付随する効果の自動化（ダメージそのものは含めない）
  if (raw['effects'] !== undefined && raw['effects'] !== null) {
    try {
      parseOps(raw['effects'], `${where} effects`);
    } catch (error) {
      if (error instanceof Error && 'issues' in error && Array.isArray(error.issues)) {
        issues.push(...(error.issues as string[]));
      } else {
        issues.push(`${where}: effects が不正です`);
      }
    }
  }
  return raw as unknown as Attack;
}

function checkAbility(raw: unknown, where: string, issues: string[]): Ability | undefined {
  if (!isRecord(raw)) {
    issues.push(`${where}: 特性がオブジェクトではありません`);
    return undefined;
  }
  if (typeof raw['name'] !== 'string' || raw['name'] === '') {
    issues.push(`${where}: 特性名がありません`);
  }
  if (typeof raw['text'] !== 'string') {
    issues.push(`${where}: 特性テキストがありません`);
  }
  if (!oneOf(raw['kind'], ABILITY_KINDS)) {
    issues.push(`${where}: kind は ${ABILITY_KINDS.join(' / ')} のいずれかです`);
  }
  // T34: いつはたらくか / 番に1回か / 自動化する効果
  if (raw['trigger'] !== undefined && !oneOf(raw['trigger'], ABILITY_TRIGGERS)) {
    issues.push(`${where}: trigger は ${ABILITY_TRIGGERS.join(' / ')} のいずれかです`);
  }
  if (raw['oncePerTurn'] !== undefined && typeof raw['oncePerTurn'] !== 'boolean') {
    issues.push(`${where}: oncePerTurn は true/false です`);
  }
  // T43: 使うと番が終わる特性
  if (raw['endsTurn'] !== undefined && typeof raw['endsTurn'] !== 'boolean') {
    issues.push(`${where}: endsTurn は true/false です`);
  }
  // T36: VSTARパワーの特性は対戦中1回
  if (raw['oncePerGame'] !== undefined && !oneOf(raw['oncePerGame'], ONCE_PER_GAME_KINDS)) {
    issues.push(`${where}: oncePerGame は ${ONCE_PER_GAME_KINDS.join(' / ')} のいずれかです`);
  }
  if (raw['effects'] !== undefined && raw['effects'] !== null) {
    try {
      parseOps(raw['effects'], `${where} effects`);
    } catch (error) {
      if (error instanceof Error && 'issues' in error && Array.isArray(error.issues)) {
        issues.push(...(error.issues as string[]));
      } else {
        issues.push(`${where}: effects が不正です`);
      }
    }
  }
  return raw as unknown as Ability;
}

const ABILITY_TRIGGERS = ['activate', 'onPlayFromHand', 'onEvolve', 'passive'] as const;
const ONCE_PER_GAME_KINDS = ['gx', 'vstar'] as const;

function checkModifier(raw: unknown, where: string, issues: string[]): void {
  if (raw === null || raw === undefined) return;
  if (!isRecord(raw)) {
    issues.push(`${where}: 弱点/抵抗は null かオブジェクトです`);
    return;
  }
  if (!oneOf(raw['type'], ENERGY_TYPES)) issues.push(`${where}: type が不正です`);
  if (typeof raw['modifier'] !== 'string') {
    issues.push(`${where}: modifier は "×2" "-20" のような文字列です`);
  }
}

const CONTINUOUS_SCOPES = ['all', 'self', 'opponent'] as const;
const CONTINUOUS_KINDS = [
  'lockAbilities',
  'lockCardKind',
  'benchLimit',
  'extraPrize',
  // T33: どうぐ・スタジアム・特殊エネルギー
  'damageModifier',
  'retreatCost',
  'nullifySpecialEnergy',
  'ignoreWeakness',
  // T34: システムポケモン
  'nullifyTools',
  // T39: 古代能力
  'effectImmunity',
  'extraAttack',
] as const;
const CONTINUOUS_ON = ['attached', 'all'] as const;

/**
 * 場に出ているあいだ効く効果の宣言（§2.2）。
 * ★中身の細かい検証は JSON Schema（第4段階でカード実装と一緒に）。
 *   ここでは「読み込みが黙って壊れない」ことだけを守る。
 */
function checkContinuous(raw: unknown, label: string, issues: string[]): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    issues.push(`${label}: continuous は配列です`);
    return;
  }
  raw.forEach((entry, i) => {
    const where = `${label} 常時効果${i + 1}`;
    if (!isRecord(entry)) {
      issues.push(`${where}: オブジェクトではありません`);
      return;
    }
    if (!oneOf(entry['kind'], CONTINUOUS_KINDS)) {
      issues.push(`${where}: kind は ${CONTINUOUS_KINDS.join(' / ')} のいずれかです`);
    }
    if (!oneOf(entry['scope'], CONTINUOUS_SCOPES)) {
      issues.push(`${where}: scope は ${CONTINUOUS_SCOPES.join(' / ')} のいずれかです`);
    }
    if (entry['kind'] === 'benchLimit' && typeof entry['limit'] !== 'number') {
      issues.push(`${where}: benchLimit には limit（数）が必要です`);
    }
    if (entry['kind'] === 'extraPrize' && typeof entry['delta'] !== 'number') {
      issues.push(`${where}: extraPrize には delta（数）が必要です`);
    }
    if (entry['kind'] === 'lockCardKind') {
      const kinds = entry['trainerKind'];
      if (!Array.isArray(kinds) || kinds.some((k) => !oneOf(k, TRAINER_KINDS))) {
        issues.push(`${where}: trainerKind は ${TRAINER_KINDS.join(' / ')} の配列です`);
      }
    }
    if (
      entry['kind'] === 'damageModifier' ||
      entry['kind'] === 'retreatCost' ||
      entry['kind'] === 'ignoreWeakness' ||
      entry['kind'] === 'effectImmunity' ||
      entry['kind'] === 'extraAttack'
    ) {
      if (!oneOf(entry['on'], CONTINUOUS_ON)) {
        issues.push(`${where}: on は ${CONTINUOUS_ON.join(' / ')} のいずれかです`);
      }
    }
    if (entry['kind'] === 'damageModifier' || entry['kind'] === 'retreatCost') {
      if (typeof entry['delta'] !== 'number') {
        issues.push(`${where}: ${String(entry['kind'])} には delta（数）が必要です`);
      }
    }
    if (entry['kind'] === 'effectImmunity') {
      const from = entry['from'];
      if (!Array.isArray(from) || from.some((k) => !oneOf(k, ['trainer', 'ability', 'attack']))) {
        issues.push(`${where}: effectImmunity には from（trainer / ability / attack の配列）が必要です`);
      }
    }
    if (entry['kind'] === 'extraAttack' && typeof entry['count'] !== 'number') {
      issues.push(`${where}: extraAttack には count（数）が必要です`);
    }
    if (entry['kind'] === 'damageModifier') {
      if (entry['applyAt'] !== 'step2' && entry['applyAt'] !== 'step5') {
        issues.push(`${where}: applyAt は step2 / step5 のいずれかです`);
      }
      if (typeof entry['label'] !== 'string' || entry['label'] === '') {
        issues.push(`${where}: 画面に出す label が必要です`);
      }
    }
  });
}

const LOCK_KINDS = [
  'abilityLock',
  'cardKindLock',
  'attackLock',
  'attackDamageImmunity',
  'benchLimit',
] as const;
const LOCK_SCOPE_PLAYERS = ['self', 'opponent', 'both'] as const;

/**
 * ロック効果の宣言（第4段階 §2.2 / T42）。
 * ★カードごとの個別実装をしないための統一表現。ここでは形だけ守らせる。
 */
function checkLocks(raw: unknown, label: string, issues: string[]): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    issues.push(`${label}: locks は配列です`);
    return;
  }
  raw.forEach((entry, i) => {
    const where = `${label} ロック${i + 1}`;
    if (!isRecord(entry)) {
      issues.push(`${where}: オブジェクトではありません`);
      return;
    }
    if (!oneOf(entry['kind'], LOCK_KINDS)) {
      issues.push(`${where}: kind は ${LOCK_KINDS.join(' / ')} のいずれかです`);
    }
    const scope = entry['scope'];
    if (!isRecord(scope)) {
      issues.push(`${where}: scope は { player, filter } です`);
    } else {
      if (!oneOf(scope['player'], LOCK_SCOPE_PLAYERS)) {
        issues.push(`${where}: scope.player は ${LOCK_SCOPE_PLAYERS.join(' / ')} のいずれかです`);
      }
      if (!isRecord(scope['filter'])) {
        issues.push(`${where}: scope.filter は条件オブジェクトです（全部なら {}）`);
      }
    }
    // ★どちらも省略させない。「自分も止まるのか」「バトル場限定か」は必ず書かせる
    if (typeof entry['exceptSelf'] !== 'boolean') {
      issues.push(`${where}: exceptSelf（発生源自身をのぞくか）は true/false で必ず書きます`);
    }
    if (typeof entry['requiresActive'] !== 'boolean') {
      issues.push(`${where}: requiresActive（バトル場限定か）は true/false で必ず書きます`);
    }
    const payload = entry['payload'];
    if (payload !== undefined && !isRecord(payload)) {
      issues.push(`${where}: payload はオブジェクトです`);
      return;
    }
    if (entry['kind'] === 'cardKindLock') {
      const kinds = payload?.['trainerKind'];
      if (!Array.isArray(kinds) || kinds.some((k) => !oneOf(k, TRAINER_KINDS))) {
        issues.push(`${where}: cardKindLock には payload.trainerKind（配列）が必要です`);
      }
    }
    if (entry['kind'] === 'benchLimit' && typeof payload?.['limit'] !== 'number') {
      issues.push(`${where}: benchLimit には payload.limit（数）が必要です`);
    }
  });
}

/**
 * 特殊エネルギーが何個ぶんはたらくかの宣言（T33）。
 * ★中身は「上から順に、最初に当てはまった行」。当てはまらなければ0個ぶん。
 */
function checkEnergyValue(raw: unknown, label: string, issues: string[]): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    issues.push(`${label}: energyValue は配列です`);
    return;
  }
  raw.forEach((entry, i) => {
    const where = `${label} energyValue${i + 1}`;
    if (!isRecord(entry)) {
      issues.push(`${where}: オブジェクトではありません`);
      return;
    }
    const provides = entry['provides'];
    if (
      provides !== 'any' &&
      (!Array.isArray(provides) || provides.some((t) => !oneOf(t, ENERGY_TYPES)))
    ) {
      issues.push(`${where}: provides は 'any' かエネルギータイプの配列です`);
    }
    if (typeof entry['amount'] !== 'number' || entry['amount'] < 0) {
      issues.push(`${where}: amount は0以上の数です（0は「はたらかない」）`);
    }
  });
}

function checkCard(raw: unknown, index: number, issues: string[]): CardText | undefined {
  const where = `[${index}]`;
  if (!isRecord(raw)) {
    issues.push(`${where}: カードがオブジェクトではありません`);
    return undefined;
  }

  for (const key of FORBIDDEN_KEYS) {
    if (key in raw) {
      issues.push(`${where}: "${key}" は絶対制約により持てません（画像・フレーバーテキスト禁止）`);
    }
  }

  const name = raw['name'];
  const label = typeof name === 'string' ? `${where} ${name}` : where;

  // 常時効果の宣言（第3段階 §2.2）。supertype によらず持てる
  checkContinuous(raw['continuous'], label, issues);

  // ロック効果の宣言（第4段階 §2.2）。supertype によらず持てる
  checkLocks(raw['locks'], label, issues);

  // 自動化する効果。未定義または null は MANUAL（T30）。
  if (raw['effects'] !== undefined && raw['effects'] !== null) {
    try {
      parseOps(raw['effects'], `${label} effects`);
    } catch (error) {
      if (error instanceof Error && 'issues' in error && Array.isArray(error.issues)) {
        issues.push(...(error.issues as string[]));
      } else {
        issues.push(`${label}: effects が不正です`);
      }
    }
  }

  // 所属タグ（第3段階 §3.1）。supertype によらず持てる
  const tags = raw['tags'];
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string'))) {
    issues.push(`${label}: tags は文字列の配列です（「ロケット団のポケモン」等）`);
  }

  if (typeof raw['functionalId'] !== 'string' || raw['functionalId'] === '') {
    issues.push(`${label}: functionalId がありません`);
  }
  if (typeof name !== 'string' || name === '') {
    issues.push(`${where}: name がありません`);
  }

  const supertype = raw['supertype'];
  if (!oneOf(supertype, ['pokemon', 'trainer', 'energy'] as const)) {
    issues.push(`${label}: supertype は pokemon / trainer / energy のいずれかです`);
    return undefined;
  }

  if (supertype === 'pokemon') {
    if (typeof raw['hp'] !== 'number' || raw['hp'] <= 0) issues.push(`${label}: hp が不正です`);
    const types = raw['types'];
    if (!Array.isArray(types) || types.length === 0 || types.some((t) => !oneOf(t, ENERGY_TYPES))) {
      issues.push(`${label}: types は1つ以上のエネルギータイプの配列です（デュアルタイプ対応）`);
    }
    if (!oneOf(raw['stage'], STAGES)) issues.push(`${label}: stage が不正です`);
    if (raw['stage'] !== 'basic' && typeof raw['evolvesFrom'] !== 'string') {
      issues.push(`${label}: たね以外は evolvesFrom が必要です`);
    }
    const ruleBox = raw['ruleBox'];
    if (ruleBox !== null && ruleBox !== undefined && !oneOf(ruleBox, RULE_BOXES)) {
      issues.push(`${label}: ruleBox が不正です`);
    }
    const attacks = raw['attacks'];
    if (!Array.isArray(attacks)) {
      issues.push(`${label}: attacks は配列です（ワザ0個なら空配列）`);
    } else {
      attacks.forEach((a, i) => checkAttack(a, `${label} ワザ${i + 1}`, issues));
    }
    const abilities = raw['abilities'];
    if (abilities !== undefined) {
      if (!Array.isArray(abilities)) {
        issues.push(`${label}: abilities は配列です`);
      } else {
        abilities.forEach((a, i) => checkAbility(a, `${label} 特性${i + 1}`, issues));
      }
    }
    checkModifier(raw['weakness'], `${label} 弱点`, issues);
    checkModifier(raw['resistance'], `${label} 抵抗`, issues);
    if (typeof raw['retreatCost'] !== 'number' || raw['retreatCost'] < 0) {
      issues.push(`${label}: retreatCost が不正です`);
    }
  }

  if (supertype === 'trainer') {
    if (!oneOf(raw['trainerKind'], TRAINER_KINDS)) {
      issues.push(`${label}: trainerKind は ${TRAINER_KINDS.join(' / ')} のいずれかです`);
    }
    if (typeof raw['text'] !== 'string' || raw['text'] === '') {
      issues.push(`${label}: トレーナーズには text が必要です`);
    }
  }

  if (supertype === 'energy') {
    if (typeof raw['isBasicEnergy'] !== 'boolean') {
      issues.push(`${label}: isBasicEnergy が必要です`);
    }
    const provides = raw['energyProvides'];
    if (!Array.isArray(provides) || provides.some((t) => !oneOf(t, ENERGY_TYPES))) {
      issues.push(`${label}: energyProvides はエネルギータイプの配列です`);
    }
    if (raw['isBasicEnergy'] === false && typeof raw['text'] !== 'string') {
      issues.push(`${label}: 特殊エネルギーには text が必要です`);
    }
    checkEnergyValue(raw['energyValue'], label, issues);
    if (raw['isBasicEnergy'] === true && raw['energyValue'] !== undefined) {
      // ★基本エネルギーは必ず1個ぶん。宣言できてしまうと派生計算の意味がなくなる
      issues.push(`${label}: 基本エネルギーに energyValue は書けません（必ず1個ぶん）`);
    }
  }

  return { ...raw, effects: raw['effects'] ?? null } as unknown as CardText;
}

/**
 * JSON を CardText[] として検証して返す。
 * 1件でも不正があれば CardDataError を投げ、問題を全部まとめて報告する。
 */
export function parseCardTexts(input: unknown): CardText[] {
  const issues: string[] = [];
  if (!Array.isArray(input)) {
    throw new CardDataError(['ルートが配列ではありません']);
  }

  const cards: CardText[] = [];
  input.forEach((raw, i) => {
    const card = checkCard(raw, i, issues);
    if (card) cards.push(card);
  });

  // functionalId は一意。name は重複してよい（別版の同名カードがあるため）
  const seen = new Set<string>();
  for (const card of cards) {
    if (seen.has(card.functionalId)) {
      issues.push(`functionalId が重複しています: ${card.functionalId}`);
    }
    seen.add(card.functionalId);
  }

  if (issues.length > 0) throw new CardDataError(issues);
  return cards;
}

// ── functionalId の生成 ──────────────────

const normalizeString = (s: string): string =>
  s.normalize('NFKC').replace(/\s+/gu, '').trim();

/**
 * functionalId のもとになる正規化テキスト。
 * 「同じ効果のカードは同じ id」にするため、印刷差（空白・全角半角）を潰す。
 */
export function normalizeCardForId(card: CardText): string {
  const parts: string[] = [
    normalizeString(card.name),
    card.supertype,
    String(card.hp ?? ''),
    (card.types ?? []).join(','),
    card.stage ?? '',
    normalizeString(card.evolvesFrom ?? ''),
    card.ruleBox ?? '',
    (card.abilities ?? [])
      .map((a) => `${a.kind}:${normalizeString(a.name)}:${normalizeString(a.text)}`)
      .join('|'),
    (card.attacks ?? [])
      .map(
        (a) =>
          `${normalizeString(a.name)}:${a.cost.join(',')}:${normalizeString(a.damage)}:${normalizeString(a.text)}`,
      )
      .join('|'),
    card.weakness ? `${card.weakness.type}${normalizeString(card.weakness.modifier)}` : '',
    card.resistance ? `${card.resistance.type}${normalizeString(card.resistance.modifier)}` : '',
    String(card.retreatCost ?? ''),
    card.trainerKind ?? '',
    card.isAceSpec ? 'ACE' : '',
    card.isBasicEnergy ? 'BASIC' : '',
    (card.energyProvides ?? []).join(','),
    // タグは効果の対象範囲を変えるので id に含める（持たないカードは空文字＝従来と同じ id）
    (card.tags ?? []).map(normalizeString).join(','),
    // 常時効果も同様。持たないカードは空文字なので既存の id は変わらない
    card.continuous ? JSON.stringify(card.continuous) : '',
    // ロック宣言も同様（T42）
    card.locks ? JSON.stringify(card.locks) : '',
    // 自動化内容が違えば別の機能ID。未定義/nullは従来IDを変えない。
    card.effects ? JSON.stringify(card.effects) : '',
    normalizeString(card.text ?? ''),
  ];
  return parts.join('');
}

/** FNV-1a を2周（オフセット違い）回して 64bit 相当の16進を作る。依存を増やさないため自前 */
function fnv1a(input: string, offset: number): number {
  let hash = offset >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * name + 正規化テキストのハッシュ（§5）。
 * 手書きの sample.json は読みやすい固定IDを使っているが、
 * 実データを取り込むときはこの関数で採番する。
 */
export function computeFunctionalId(card: CardText): string {
  const src = normalizeCardForId(card);
  const a = fnv1a(src, 0x811c9dc5).toString(16).padStart(8, '0');
  const b = fnv1a(src, 0x9e3779b1).toString(16).padStart(8, '0');
  return `fn-${a}${b}`;
}

// ── 索引 ─────────────────────────────

export interface CardIndex {
  all: readonly CardText[];
  /** エンジンが引くのはこちら（§5.1-6） */
  byFunctionalId: ReadonlyMap<string, CardText>;
  /** 4枚制限が引くのはこちら。同名の別版が複数入りうるので配列 */
  byName: ReadonlyMap<string, readonly CardText[]>;
}

export function buildCardIndex(cards: readonly CardText[]): CardIndex {
  const byFunctionalId = new Map<string, CardText>();
  const byName = new Map<string, CardText[]>();
  for (const card of cards) {
    byFunctionalId.set(card.functionalId, card);
    const bucket = byName.get(card.name);
    if (bucket) bucket.push(card);
    else byName.set(card.name, [card]);
  }
  return { all: cards, byFunctionalId, byName };
}

/** 同名エイリアス表を通した正規化名。4枚制限はこの名前で数える（§5.1-7） */
export function canonicalName(name: string, aliases: NameAliasTable = {}): string {
  return aliases[name] ?? name;
}
