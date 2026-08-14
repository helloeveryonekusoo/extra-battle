/**
 * 派生状態レイヤ（第3段階 §2.2 / T27）。
 *
 * ★常時型の効果を **状態に書き込まない**。参照するたびに場から計算する。
 *
 *   理由はロックが解除されうるから。クレッフィがトラッシュされれば
 *   ダストオキシンの効果は消え、止まっていた特性が復活する。
 *   `state` に「この特性は無効」と書き込む方式だと、この巻き戻しが正しく動かない。
 *   （書き込んだ側を消す処理が必ずどこかで漏れる）
 *
 *   だからここにある関数は、呼ばれるたびに
 *   「いま場に出ているカード」を集め直して答えを出す。カードが場を離れれば、
 *   次に呼んだ瞬間から効果は消えている。消す処理は要らない。
 *
 * ★衝突は「できない」を優先する（§2.3）。
 *   「●●する」と「●●できない」が重なったら「できない」が勝つ。
 *   ベンチ上限は **低いほうを採用**（スカイフィールド8 と ウソッキー4 が同時なら4）。
 *
 * ★ロック系カードそのものの実装は第4段階（§6）。
 *   ここで作るのは「カードが宣言した常時効果を集めて答えを出す」層だけ。
 */
import { matchesCardFilter } from './cardFilter';
import type { CardIndex } from './cards';
import { effectiveProfileOf } from './effectiveCard';
import { describeEffect, effectSlotKey, effectsOnSlot, parseEffectSlotKey } from './effects';
import { prizesForRuleBox } from './knockout';
import {
  abilityLockOn,
  attackLockOn,
  benchLimitFrom,
  cardKindLockOn,
  collectLocks,
  judgeLock,
  lockHits,
  NO_LOCK,
  type LockSource,
  type LockVerdict,
} from './lock';
import type { RuleContext } from './rules';
import type {
  Ability,
  CardText,
  ContinuousEffect,
  ContinuousScope,
  EnergyType,
  GameState,
  PlayerId,
  PokemonInPlay,
  SlotId,
  TrainerKind,
} from './types';

/** ベンチ上限の既定値。カードが何も言わなければこれ（可変にすること。§5.1-1） */
export const DEFAULT_BENCH_LIMIT = 5;

/**
 * ロックで止まる能力の種類。
 * ★古代能力（ancientTrait）は特性ではないので止まらない。
 */
const LOCKABLE_ABILITY_KINDS: readonly Ability['kind'][] = ['ability', 'pokeBody', 'pokePower'];

// ── 場に出ているカードを集める ───────────

export interface InPlayCard {
  instanceId: string;
  card: CardText;
  /** そのカードを場に出している側 */
  controllerId: PlayerId;
  /** ポケモンならその居場所。スタジアムなら null */
  slotId: SlotId | null;
}

/**
 * いま場に出ているカードを、ロックを一切考えずにそのまま集める（T42）。
 *
 * 集めるのは4か所:
 *   - 各スロットの進化スタックの一番上（特性を持つのは一番上だけ）
 *   - ついているどうぐ
 *   - ★ついているエネルギー（ダブルターボ・ストロング等が常時効果を出す。T33）
 *   - 出ているスタジアム
 *
 * ★これが §2.1 の「素の盤面」。ロックの判定はここを入力にする。
 */
export function rawCardsInPlay(state: GameState, ctx: RuleContext = {}): InPlayCard[] {
  const index: CardIndex | null | undefined = ctx.cards;
  const out: InPlayCard[] = [];

  const push = (instanceId: string | null, controllerId: PlayerId, slotId: SlotId | null): void => {
    if (!instanceId) return;
    const instance = state.cards[instanceId];
    if (!instance || instance.functionalId === '') return;
    const card = index?.byFunctionalId.get(instance.functionalId);
    if (!card) return;
    out.push({ instanceId, card, controllerId, slotId });
  };

  for (const [playerId, player] of Object.entries(state.players)) {
    for (const slot of player.pokemon) {
      push(slot.stack[slot.stack.length - 1] ?? null, playerId, slot.slotId);
      for (const energyId of slot.attachedEnergy) push(energyId, playerId, slot.slotId);
      if (slot.attachedTool) push(slot.attachedTool, playerId, slot.slotId);
    }
  }

  if (state.stadium) {
    const owner = state.cards[state.stadium]?.ownerId;
    // スタジアムは出した人の持ち物だが、効果は両者に及ぶことが多い（scope で表す）
    if (owner) push(state.stadium, owner, null);
  }

  return out;
}

/**
 * いま常時効果を出しているカード。
 *
 * ★素の盤面から、効果を止められているカード（ダストオキシン下のどうぐ）を落としたもの。
 *   ロック自体は素の盤面から集めているので、
 *   「ロックを止めるロック」を追いかける繰り返しは起きない（§2.1 の1パス評価）。
 */
export function cardsInPlay(state: GameState, ctx: RuleContext = {}): InPlayCard[] {
  const raw = rawCardsInPlay(state, ctx);
  const locks = collectLocks(state, ctx);
  if (locks.length === 0) return raw;

  return raw.filter((entry) => {
    // 止められるのは「カードとしての効果」。ポケモン本体の特性は abilityLockOn で判定する
    if (entry.card.trainerKind !== 'tool') return true;
    return !toolIsLocked(locks, entry);
  });
}

/**
 * どうぐ1枚が abilityLock の対象になっているか（ダストオキシン）。
 * ★条件を書いていないロック（「すべてのポケモンの特性がなくなる」）は
 *   どうぐを止めない。どうぐを止めるには条件でどうぐを名指しする。
 */
const toolIsLocked = (locks: readonly LockSource[], entry: InPlayCard): boolean =>
  locks.some(
    (source) =>
      source.lock.kind === 'abilityLock' &&
      lockHits(
        source,
        {
          playerId: entry.controllerId,
          slotId: entry.slotId,
          instanceId: entry.instanceId,
          card: entry.card,
        },
        { requireExplicitFilter: true },
      ),
  );

/**
 * そのプレイヤーのどうぐの効果が消されているか（ダストオキシン）。
 * ★実際にどうぐがついているかによらず、「いま止まる状況か」を答える。
 *   画面の説明に使うので、つける前から分かる必要がある。
 */
export function toolsNullified(
  state: GameState,
  player: PlayerId,
  ctx: RuleContext = {},
): boolean {
  return judgeLock(
    state,
    'abilityLock',
    { playerId: player, slotId: null, card: ANY_TOOL },
    ctx,
    undefined,
    { requireExplicitFilter: true },
  ).locked;
}

/** 「どうぐというカード」を表す最小の見本。条件がどうぐを指しているかを試すために使う */
const ANY_TOOL: CardText = {
  functionalId: '',
  name: 'ポケモンのどうぐ',
  supertype: 'trainer',
  trainerKind: 'tool',
};

/** その常時効果が、対象のプレイヤーに及ぶか */
function scopeCovers(scope: ContinuousScope, controllerId: PlayerId, targetId: PlayerId): boolean {
  switch (scope) {
    case 'all':
      return true;
    case 'self':
      return controllerId === targetId;
    case 'opponent':
      return controllerId !== targetId;
  }
}

/**
 * いま場に効いている常時効果を、対象プレイヤーごとに拾う。
 * ★毎回集め直す。これが派生状態レイヤの本体。
 */
export function continuousEffectsFor(
  state: GameState,
  targetId: PlayerId,
  ctx: RuleContext = {},
): { effect: ContinuousEffect; from: InPlayCard }[] {
  const out: { effect: ContinuousEffect; from: InPlayCard }[] = [];
  for (const from of cardsInPlay(state, ctx)) {
    for (const effect of from.card.continuous ?? []) {
      if (scopeCovers(effect.scope, from.controllerId, targetId)) out.push({ effect, from });
    }
  }
  return out;
}

// ── §2.2 が名指しする4つ ────────────────

/**
 * そのポケモンの特性が現在有効か。場のロック効果をすべて集めて判定する。
 *
 * slotKey は `p-1/active` の形（effects.ts と同じ）。
 *
 * ★ロックを出しているカード自身の常時効果は止まらない。
 *   ダストオキシンが2枚あっても互いを打ち消さない、という裁定に合わせる。
 *   （常時効果の宣言は abilities とは別枠なので、構造的にそうなる）
 */
export function getEffectiveAbilities(
  state: GameState,
  slotKey: string,
  ctx: RuleContext = {},
): Ability[] {
  return getEffectiveAbilityEntries(state, slotKey, ctx)
    .filter((entry) => !entry.lock.locked)
    .map((entry) => entry.ability);
}

/** 特性1つぶんの見え方。★止まっていても一覧から消さない（§4.1 のグレーアウト用） */
export interface AbilityEntry {
  ability: Ability;
  instanceId: string;
  abilityIndex: number;
  fromCard: CardText | undefined;
  /** 止まっているか・その理由（T42） */
  lock: LockVerdict;
}

/**
 * 特性を「どのカードのどの番号か」つきで返す（T37）。
 *
 * ★BREAK進化していると、特性が2枚のカードにまたがる。
 *   使用回数は CardInstance 単位（T34）なので、
 *   どちらの特性を使うのかを instanceId まで込みで指し示す必要がある。
 */
export function getEffectiveAbilityEntries(
  state: GameState,
  slotKey: string,
  ctx: RuleContext = {},
): AbilityEntry[] {
  const parsed = parseEffectSlotKey(slotKey);
  if (!parsed) return [];
  const profile = effectiveProfileOf(state, parsed.playerId, parsed.slotId, ctx);
  if (profile.abilities.length === 0) return [];

  /*
   * ロックの判定は **場に出ているポケモンそのもの**（＝一番上のカード）で行う。
   * BREAKなら、下から引きついだ特性もBREAK側の条件で止まる。
   * 「サイレントラボはたねポケモンの特性を止める」の たね かどうかは、
   * 場にいるポケモン（BREAK）で決まるため。
   *
   * ★判定は lock.ts に一本化してある（§2.2）。ここでは呼ぶだけ。
   */
  const verdict = abilityLockOn(state, parsed.playerId, parsed.slotId, ctx);

  return profile.abilities.map(({ ability, from, index }) => ({
    ability,
    instanceId: from.instanceId,
    abilityIndex: index,
    fromCard: from.card,
    // ★古代能力は特性ではないのでロックされない
    lock: LOCKABLE_ABILITY_KINDS.includes(ability.kind) ? verdict : NO_LOCK,
  }));
}

/**
 * そのプレイヤーが今そのカード種別を使えるか（グッズロック等）。
 * ★「できない」が1つでもあれば使えない（§2.3）。
 */
export function canUseCardKind(
  state: GameState,
  player: PlayerId,
  kind: TrainerKind,
  ctx: RuleContext = {},
  card?: CardText | undefined,
): boolean {
  return !cardKindLockOn(state, player, kind, ctx, card).locked;
}

/**
 * ベンチ上限。スカイフィールド8 / ウソッキー4 / ムゲンゾーン8 を合成して算出。
 *
 * ★**低いほうが優先される**（§2.2）。
 *   スカイフィールドとウソッキーが同時に出ていれば 4。
 *
 * カードが何も言っていなければ、手で設定した値（PlayerState.benchLimit）をそのまま使う。
 * 第2段階までの手動運用をここで壊さないため。
 */
export function getBenchLimit(
  state: GameState,
  player: PlayerId,
  ctx: RuleContext = {},
): number {
  const declared = benchLimitFrom(state, player, ctx);
  if (!declared) return state.players[player]?.benchLimit ?? DEFAULT_BENCH_LIMIT;
  return declared.limit;
}

/** ベンチ上限の内訳。画面のツールチップに出す（§4.1） */
export function benchLimitDetail(
  state: GameState,
  player: PlayerId,
  ctx: RuleContext = {},
): { limit: number; used: number; free: number; sources: string[] } {
  const limit = getBenchLimit(state, player, ctx);
  const used = (state.players[player]?.pokemon ?? []).filter(
    (slot) => slot.slotId !== 'active' && slot.stack.length > 0,
  ).length;
  return {
    limit,
    used,
    // ★上限を下げた結果あふれることがある（§2.3）。そのときは 0 を返す。減らすのは手動
    free: Math.max(0, limit - used),
    sources: benchLimitFrom(state, player, ctx)?.sources ?? [],
  };
}

/**
 * そのポケモンがきぜつしたときにとられるサイド枚数。
 *
 *   ルールボックスから出る既定値
 * + かかっている効果（オルタージェネシスGX 等の extraPrize）
 * + 場に出ているカードの常時効果
 */
export function getPrizeCount(
  state: GameState,
  slotKey: string,
  ctx: RuleContext = {},
): number {
  const parsed = parseEffectSlotKey(slotKey);
  if (!parsed) return 1;
  const slot = state.players[parsed.playerId]?.pokemon.find((p) => p.slotId === parsed.slotId);
  if (!slot) return 1;

  const topId = slot.stack[slot.stack.length - 1];
  const instance = topId ? state.cards[topId] : undefined;
  const card = instance ? ctx.cards?.byFunctionalId.get(instance.functionalId) : undefined;
  const base = prizesForRuleBox(card?.ruleBox);

  // かかっている効果ぶん。サイドをとるのは「持ち主の相手」なので、その人にかかる
  const taker = Object.keys(state.players).find((id) => id !== parsed.playerId);
  const fromEffects = state.effects
    .filter((e) => e.kind === 'extraPrize')
    .filter((e) => {
      if ('global' in e.target) return true;
      if ('player' in e.target) return e.target.player === taker;
      return e.target.slotId === slotKey;
    })
    .reduce((sum, e) => sum + (typeof e.payload['delta'] === 'number' ? e.payload['delta'] : 0), 0);

  const fromBoard = taker
    ? continuousEffectsFor(state, taker, ctx).reduce(
        (sum, { effect }) => sum + (effect.kind === 'extraPrize' ? effect.delta : 0),
        0,
      )
    : 0;

  return Math.max(0, base + fromEffects + fromBoard);
}

/** 便利形。スロットを直接渡す版 */
export const prizeCountForSlot = (
  state: GameState,
  playerId: PlayerId,
  slotId: SlotId,
  ctx: RuleContext = {},
): number => getPrizeCount(state, effectSlotKey(playerId, slotId), ctx);

// ── ★「自分の番に1回」は CardInstance 単位で数える（T34） ──

/**
 * 使用記録のキー。
 * ★カードの種類ではなく **実体** ごとに数える。
 *   デデンネGX が2匹いれば、それぞれ1回ずつデデチェンジできる。
 */
export const abilityUseKey = (instanceId: string, abilityIndex: number): string =>
  `${instanceId}#${abilityIndex}`;

/**
 * その特性を、この番にまだ使えるか。
 *
 * ★「使った番の番号」を持ち、いまの番と違えば使える、という形にしてある。
 *   番の終わりにカウンタを0へ戻す処理を書かないので、
 *   Undo で番が戻れば使用権も自然に戻る。
 */
export function canUseAbilityThisTurn(
  state: GameState,
  instanceId: string,
  abilityIndex: number,
): boolean {
  return state.abilityUses[abilityUseKey(instanceId, abilityIndex)] !== state.turn;
}

/** その特性の定義。見えない・存在しなければ undefined */
export function abilityOf(
  state: GameState,
  instanceId: string,
  abilityIndex: number,
  ctx: RuleContext = {},
): Ability | undefined {
  const instance = state.cards[instanceId];
  if (!instance || instance.functionalId === '') return undefined;
  return ctx.cards?.byFunctionalId.get(instance.functionalId)?.abilities?.[abilityIndex];
}

// ── ★特殊エネルギーは「何個ぶんはたらくか」を毎回計算する（T33） ──

/**
 * エネルギー1枚が、いまついているポケモンの上で何個ぶんはたらくか。
 *
 * ★ここが T33 の肝。`energyValue` を固定値として持たない理由:
 *
 *   ダブルドラゴンエネルギー … ドラゴンポケモンの上でだけ 2個ぶん
 *   トリプル加速エネルギー   … 進化ポケモンの上でだけ 3個ぶん
 *   ツインエネルギー         … ルールを持つポケモンの上では **0個ぶん**
 *   シンオウ神殿が出ている   … どの特殊エネルギーも 無色1個ぶんに落ちる
 *
 *   同じカードでも、つけ替えたり進化したり、スタジアムが張り替わったりすれば
 *   答えが変わる。カードに書いた数を state に写した瞬間に必ずずれるので、
 *   参照するたびにここで計算する。
 */
export interface EnergyValue {
  instanceId: string;
  /** 支払えるタイプ。'any' は好きなタイプ1つとして使える */
  types: EnergyType[] | 'any';
  /** 何個ぶん。0 なら「はたらいていない」 */
  amount: number;
  /** 画面とログに出す説明 */
  label: string;
}

const TYPE_LABEL: Record<EnergyType, string> = {
  grass: '草',
  fire: '炎',
  water: '水',
  lightning: '雷',
  psychic: '超',
  fighting: '闘',
  darkness: '悪',
  metal: '鋼',
  fairy: 'フェアリー',
  dragon: 'ドラゴン',
  colorless: '無色',
};

const describeEnergyValue = (types: EnergyType[] | 'any', amount: number): string => {
  if (amount === 0) return 'はたらいていない';
  const label = types === 'any' ? '好きなタイプ' : types.map((t) => TYPE_LABEL[t]).join('・');
  return `${label}${amount}個ぶん`;
};

/** そのプレイヤーの場で、特殊エネルギーのはたらきが消されているか（シンオウ神殿） */
export function specialEnergyNullified(
  state: GameState,
  player: PlayerId,
  ctx: RuleContext = {},
): boolean {
  return continuousEffectsFor(state, player, ctx).some(
    ({ effect }) => effect.kind === 'nullifySpecialEnergy',
  );
}

/**
 * エネルギー1枚ぶんの働きを求める。
 * slot は「そのエネルギーがついているポケモン」。場を離れていれば undefined を渡す。
 */
export function energyValueOf(
  state: GameState,
  instanceId: string,
  slot: PokemonInPlay | undefined,
  owner: PlayerId,
  ctx: RuleContext = {},
): EnergyValue {
  const instance = state.cards[instanceId];
  const card = instance && instance.functionalId !== ''
    ? ctx.cards?.byFunctionalId.get(instance.functionalId)
    : undefined;

  // 正体が分からないカードは判断材料がない。1個ぶんとして扱い、人の目に任せる
  if (!card || card.supertype !== 'energy') {
    return { instanceId, types: 'any', amount: 1, label: '1個ぶん（不明）' };
  }

  const provides = card.energyProvides ?? [];

  if (card.isBasicEnergy) {
    return {
      instanceId,
      types: provides,
      amount: 1,
      label: describeEnergyValue(provides, 1),
    };
  }

  // ★シンオウ神殿。特殊エネルギーのはたらきは消えるが、無色1個ぶんとしては残る
  if (specialEnergyNullified(state, owner, ctx)) {
    return {
      instanceId,
      types: ['colorless'],
      amount: 1,
      label: '無色1個ぶん（特殊エネルギーのはたらきは消えている）',
    };
  }

  // 宣言がなければ「書かれたタイプで1個ぶん」
  if (!card.energyValue || card.energyValue.length === 0) {
    return { instanceId, types: provides, amount: 1, label: describeEnergyValue(provides, 1) };
  }

  const topId = slot?.stack[slot.stack.length - 1];
  const attachedTo = topId ? state.cards[topId] : undefined;
  const attachedCard = attachedTo && attachedTo.functionalId !== ''
    ? ctx.cards?.byFunctionalId.get(attachedTo.functionalId)
    : undefined;

  for (const rule of card.energyValue) {
    // ★条件付きの行は、つけられているポケモンが分かるときだけ通す。
    //   相手の伏せたポケモンを勝手に「条件に合う」と扱わない（cardFilter と同じ考え方）
    if (rule.when && !matchesCardFilter(attachedCard, rule.when)) continue;
    return {
      instanceId,
      types: rule.provides,
      amount: rule.amount,
      label: rule.label ?? describeEnergyValue(rule.provides, rule.amount),
    };
  }

  // どの行にも当てはまらない＝はたらかない（ツインエネルギーをルール持ちにつけた等）
  return { instanceId, types: [], amount: 0, label: 'はたらいていない' };
}

/** そのポケモンについているエネルギーを、1枚ずつ働きに直して並べる */
export function energyOnSlot(
  state: GameState,
  playerId: PlayerId,
  slotId: SlotId,
  ctx: RuleContext = {},
): EnergyValue[] {
  const slot = state.players[playerId]?.pokemon.find((entry) => entry.slotId === slotId);
  if (!slot) return [];
  return slot.attachedEnergy.map((instanceId) =>
    energyValueOf(state, instanceId, slot, playerId, ctx),
  );
}

/** ついているエネルギーの合計個数。★枚数ではなく「何個ぶん」 */
export function energyCountOn(
  state: GameState,
  playerId: PlayerId,
  slotId: SlotId,
  ctx: RuleContext = {},
): number {
  return energyOnSlot(state, playerId, slotId, ctx).reduce((sum, value) => sum + value.amount, 0);
}

/**
 * ワザ・にげるのコストを払えるか。
 *
 * ★判定するだけで **止めない**（第2段階 §2）。
 *   呼び出し側は警告に使う。特殊なコスト（すべてのエネルギーをトラッシュ等）は
 *   ここでは扱いきれないので、払えないと出ても操作は通す。
 *
 * 無色は何でも払える。色つきのコストから先に割り当てる。
 */
export function canPayCost(cost: readonly EnergyType[], available: readonly EnergyValue[]): boolean {
  // 「1個ぶん」の粒に分解する。'any' と多タイプはどの色にも回せる
  const units: (EnergyType[] | 'any')[] = [];
  for (const value of available) {
    for (let i = 0; i < value.amount; i += 1) units.push(value.types);
  }

  const colored = cost.filter((type) => type !== 'colorless');
  const colorless = cost.length - colored.length;

  // 色つきを先に割り当てる。選択肢の少ない粒から使うと取り合いで詰まりにくい
  const remaining = [...units];
  for (const type of colored) {
    const candidates = remaining
      .map((unit, index) => ({ unit, index }))
      .filter(({ unit }) => unit === 'any' || unit.includes(type))
      .sort((a, b) => width(a.unit) - width(b.unit));
    const chosen = candidates[0];
    if (!chosen) return false;
    remaining.splice(chosen.index, 1);
  }
  return remaining.length >= colorless;
}

const width = (unit: EnergyType[] | 'any'): number => (unit === 'any' ? 99 : unit.length);

// ── どうぐ・スタジアムの常時効果（T33） ──────

/** その常時効果が、このスロットに効くか */
function continuousHitsSlot(
  state: GameState,
  effect: Extract<ContinuousEffect, { on: 'attached' | 'all' }>,
  from: InPlayCard,
  playerId: PlayerId,
  slotId: SlotId,
  ctx: RuleContext,
): boolean {
  if (effect.on === 'attached') {
    // このカードをつけているポケモンだけ。スタジアムのように場所を持たない発生源は対象外
    if (from.slotId === null) return false;
    if (from.controllerId !== playerId || from.slotId !== slotId) return false;
  }
  const where = 'where' in effect ? effect.where : undefined;
  if (where === 'active' && slotId !== 'active') return false;
  if (where === 'bench' && slotId === 'active') return false;

  const selfFilter = 'selfFilter' in effect ? effect.selfFilter : undefined;
  if (selfFilter && !matchesCardFilter(topCardTextOf(state, playerId, slotId, ctx), selfFilter)) {
    return false;
  }
  return true;
}

/**
 * ★相手の効果を受けないか（Ωバリア / フュージョンエネルギー。T39 → T44）。
 *
 * `sourceKind` は「その効果がどこから出ているか」。
 *   'trainer' … トレーナーズのカード（Ωバリアが防ぐ）
 *   'ability' … 相手のポケモンの特性（フュージョンエネルギーが防ぐ）
 *   'attack'  … ワザ
 *
 * ★古代能力は特性とは別枠なので、特性ロックでは止まらない。
 *   continuous の宣言は abilities とは別に集めているので、構造的にそうなる。
 */
export function isImmuneToEffectFrom(
  state: GameState,
  playerId: PlayerId,
  slotId: SlotId,
  sourceKind: 'trainer' | 'ability' | 'attack',
  ctx: RuleContext = {},
): boolean {
  return continuousEffectsFor(state, playerId, ctx).some(
    ({ effect, from }) =>
      effect.kind === 'effectImmunity' &&
      effect.from.includes(sourceKind) &&
      continuousHitsSlot(state, effect, from, playerId, slotId, ctx),
  );
}

/**
 * ★この番に、そのポケモンが使えるワザの回数（Ω連打。T39）。
 *
 * ★「1番に1回」を定数にしない。既定は1で、そこに増分を足す。
 *   増分は2系統ある:
 *     1. 常時型の宣言（continuous の extraAttack）… Ω連打のように刷られている古代能力
 *     2. かかっている効果（ActiveEffect の extraAttack）… 指示書 §T39 が名指しした形。
 *        「この番だけワザを2回使える」を効果として与えるカード用
 */
export function attackAllowanceFor(
  state: GameState,
  playerId: PlayerId,
  slotId: SlotId,
  ctx: RuleContext = {},
): number {
  const fromBoard = continuousEffectsFor(state, playerId, ctx).reduce((sum, { effect, from }) => {
    if (effect.kind !== 'extraAttack') return sum;
    return continuousHitsSlot(state, effect, from, playerId, slotId, ctx) ? sum + effect.count : sum;
  }, 0);

  const fromEffects = effectsOnSlot(state, playerId, slotId).reduce((sum, effect) => {
    if (effect.kind !== 'extraAttack') return sum;
    const count = effect.payload['count'];
    return sum + (typeof count === 'number' ? count : 1);
  }, 0);

  return Math.max(1, 1 + fromBoard + fromEffects);
}

/**
 * この番、まだワザを使えるか。
 * ★ワザ封じ（メガニウム。T42）は回数の問題ではないので別に見る。
 *   封じられていれば「貫通する」ワザも通らない。
 */
export function canAttackAgain(
  state: GameState,
  playerId: PlayerId,
  slotId: SlotId,
  ctx: RuleContext = {},
): boolean {
  if (attackBlock(state, playerId, slotId, ctx).blocked) return false;
  const used = state.players[playerId]?.turnFlags.attacksUsed ?? 0;
  return used < attackAllowanceFor(state, playerId, slotId, ctx);
}

/**
 * ★そのポケモンが「そもそもワザを使えない」状態か。回数とは別の話（T42 / T43）。
 *
 * 2系統ある:
 *   1. 場のロック宣言（メガニウム等）… 発生源が場を離れれば消える
 *   2. かかっている効果（`cannotUseAttack`）… ザシアンVのふとうのつるぎ、
 *      ブレイブキャリバーの反動など。一度かかったら期間まで残る
 */
export function attackBlock(
  state: GameState,
  playerId: PlayerId,
  slotId: SlotId,
  ctx: RuleContext = {},
): { blocked: boolean; reason: string; assisted: boolean } {
  const lock = attackLockOn(state, playerId, slotId, ctx);
  if (lock.locked) return { blocked: true, reason: lock.reason, assisted: lock.assisted };

  const effect = effectsOnSlot(state, playerId, slotId).find((e) => e.kind === 'cannotUseAttack');
  if (effect) return { blocked: true, reason: describeEffect(effect), assisted: false };

  return { blocked: false, reason: '', assisted: false };
}

/**
 * そのポケモンが弱点を計算しないか（ウィークガードエネルギー）。
 * ★受ける側の状態なので、パイプラインの入力を組み立てるときに見る。
 */
export function ignoresWeakness(
  state: GameState,
  playerId: PlayerId,
  slotId: SlotId,
  ctx: RuleContext = {},
): boolean {
  return continuousEffectsFor(state, playerId, ctx).some(
    ({ effect, from }) =>
      effect.kind === 'ignoreWeakness' &&
      continuousHitsSlot(state, effect, from, playerId, slotId, ctx),
  );
}

/**
 * にげるためのエネルギー。ふうせん等を合成する。
 * ★0未満にはならない。
 */
export function getRetreatCost(
  state: GameState,
  playerId: PlayerId,
  slotId: SlotId,
  ctx: RuleContext = {},
): number {
  const slot = state.players[playerId]?.pokemon.find((entry) => entry.slotId === slotId);
  if (!slot) return 0;
  // ★BREAK進化なら にげる は進化前から引きつぐ（T37）
  const base = effectiveProfileOf(state, playerId, slotId, ctx).retreatCost;
  const delta = continuousEffectsFor(state, playerId, ctx).reduce((sum, { effect, from }) => {
    if (effect.kind !== 'retreatCost') return sum;
    return continuousHitsSlot(state, effect, from, playerId, slotId, ctx) ? sum + effect.delta : sum;
  }, 0);

  return Math.max(0, base + delta);
}

/**
 * 場のカードが出しているダメージ増減を集める（T28 の Step2 / Step5 に流す）。
 *
 * ★state に書き込まない。どうぐを外した瞬間から次の計算に反映される。
 */
export function continuousDamageModifier(
  state: GameState,
  attacker: { playerId: PlayerId; slotId: SlotId },
  defender: { playerId: PlayerId; slotId: SlotId },
  applyAt: 'step2' | 'step5',
  ctx: RuleContext = {},
): { delta: number; sources: string[] } {
  // step2 は与える側、step5 は受ける側にかかっているものを見る
  const side = applyAt === 'step2' ? attacker : defender;
  const defenderCard = topCardTextOf(state, defender.playerId, defender.slotId, ctx);

  let delta = 0;
  const sources: string[] = [];
  for (const { effect, from } of continuousEffectsFor(state, side.playerId, ctx)) {
    if (effect.kind !== 'damageModifier' || effect.applyAt !== applyAt) continue;
    if (!continuousHitsSlot(state, effect, from, side.playerId, side.slotId, ctx)) continue;
    // 受ける側への条件（こだわりハチマキ）。相手の正体が分からなければ効かせない
    if (effect.defenderFilter && !matchesCardFilter(defenderCard, effect.defenderFilter)) continue;
    delta += effect.delta;
    sources.push(effect.label);
  }
  return { delta, sources };
}

/** 進化スタックの一番上のカード定義。見えない・定義がなければ undefined */
export function topCardTextOf(
  state: GameState,
  playerId: PlayerId,
  slotId: SlotId,
  ctx: RuleContext = {},
): CardText | undefined {
  const slot = state.players[playerId]?.pokemon.find((entry) => entry.slotId === slotId);
  const topId = slot?.stack[slot.stack.length - 1];
  const instance = topId ? state.cards[topId] : undefined;
  if (!instance || instance.functionalId === '') return undefined;
  return ctx.cards?.byFunctionalId.get(instance.functionalId);
}
