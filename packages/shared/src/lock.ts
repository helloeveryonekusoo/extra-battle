/**
 * ロック効果の判定（第4段階 §2.1 / §2.2 / T42）。
 *
 * ★ここが唯一の判定場所。カードごとの個別コードは書かない。
 *   カードは `locks: LockEffect[]` を宣言するだけで、判定はすべてこのファイルを通る。
 *
 * ★固定点計算をしない（§2.1）。手順は1パス:
 *
 *     1. 素の盤面（ロックを一切かけていない状態）から、ロック効果を集める
 *     2. 集めたものを合成する
 *     3. 各ポケモン・各プレイヤーについて判定する
 *     4. **繰り返さない**
 *
 *   つまり「ロック効果自体はロックの影響を受けない」。
 *   ガラルマタドガスが2匹並んでも互いを打ち消さないし、
 *   頂への雪道はサイレントラボの下でも効いている。
 *
 *   実際にはこれで割り切れない裁定が存在する（シャワーズ／ラウドボーン／メモリーカプセル）。
 *   完璧に解こうとすると必ず破綻するので、
 *   ★ロック効果が2つ以上同時に場にあるときは警告を出し、
 *     影響を受けているポケモンを ASSISTED に落として人の判断に委ねる。
 *
 * ★解除処理を書かない。
 *   宣言はカードの静的な定義なので、発生源が場を離れれば次の呼び出しから消えている。
 */
import { matchesCardFilter } from './cardFilter';
import type { CardFilter } from './dsl';
import { effectsOnPlayer } from './effects';
import type { RuleContext } from './rules';
import type {
  CardText,
  GameState,
  LockEffect,
  LockKind,
  LockZone,
  PlayerId,
  SlotId,
  TrainerKind,
} from './types';

/** 判定の対象になったカード1枚 */
export interface LockTarget {
  playerId: PlayerId;
  /** ポケモンならその居場所。手札のカードなど、場にないものは null */
  slotId: SlotId | null;
  /** そのカードの実体。発生源自身かどうか（exceptSelf）の判定に使う */
  instanceId?: string | null;
  card: CardText | undefined;
  /** そのカードが今どこにあるか。省略は場（T43） */
  zone?: LockZone;
}

/** 場に出ている「ロックを出しているカード」 */
export interface LockSource {
  lock: LockEffect;
  instanceId: string;
  card: CardText;
  /** そのカードを場に出している側 */
  controllerId: PlayerId;
  /** ポケモンならその居場所。スタジアムなら null */
  slotId: SlotId | null;
}

/**
 * 判定の結果。
 * ★`locked` と `assisted` は別物。
 *   locked   = 1パス評価の答え
 *   assisted = その答えを信用してよいか（§2.1。複数ロックが同時にあるときは false 扱い）
 */
export interface LockVerdict {
  locked: boolean;
  /** ★人の判断に委ねる。画面では「要確認」を出し、操作は止めない */
  assisted: boolean;
  /** 画面に出す理由。locked でなければ空 */
  reason: string;
  /** 発生源のカード名 */
  sources: string[];
}

export const NO_LOCK: LockVerdict = { locked: false, assisted: false, reason: '', sources: [] };

export const LOCK_KIND_LABEL: Record<LockKind, string> = {
  abilityLock: '特性ロック',
  cardKindLock: 'カード種別ロック',
  attackLock: 'ワザ封じ',
  attackDamageImmunity: 'ワザのダメージ無効',
  benchLimit: 'ベンチ上限',
};

const TRAINER_KIND_LABEL: Record<TrainerKind, string> = {
  item: 'グッズ',
  supporter: 'サポート',
  stadium: 'スタジアム',
  tool: 'ポケモンのどうぐ',
};

const LOCK_KIND_SENTENCE: Record<LockKind, string> = {
  abilityLock: '特性がなくなる',
  cardKindLock: 'カードが使えない',
  attackLock: 'ワザが使えない',
  attackDamageImmunity: 'ワザのダメージを受けない',
  benchLimit: 'ベンチ上限が変わる',
};

/** その宣言の説明文。カードが label を書いていればそれを使う */
export function describeLock(source: LockSource): string {
  if (source.lock.label) return source.lock.label;
  const kinds = trainerKindsOf(source.lock);
  if (source.lock.kind === 'cardKindLock' && kinds.length > 0) {
    return `${kinds.map((k) => TRAINER_KIND_LABEL[k]).join('・')}が使えない`;
  }
  if (source.lock.kind === 'benchLimit') {
    return `ベンチ上限 ${benchLimitOf(source.lock) ?? '?'}`;
  }
  return LOCK_KIND_SENTENCE[source.lock.kind];
}

// ── payload の読み取り（型のない場所はここだけに閉じ込める） ──

export function trainerKindsOf(lock: LockEffect): TrainerKind[] {
  const raw = lock.payload?.['trainerKind'];
  return Array.isArray(raw) ? (raw.filter((k) => typeof k === 'string') as TrainerKind[]) : [];
}

/**
 * ★「このカードは出せない」を種別以外でも指せるようにする条件（T43）。
 *   こくばバドレックスVの シャドーミストは「**特殊エネルギー**を出してつけられず
 *   **スタジアム**も出せない」。特殊エネルギーはトレーナーズの種別では指せないので、
 *   カードそのものへの条件で表す。trainerKind と **どちらか当てはまれば** 止まる。
 */
export function playFilterOf(lock: LockEffect): CardFilter | null {
  const raw = lock.payload?.['filter'];
  return raw && typeof raw === 'object' ? (raw as CardFilter) : null;
}

export function benchLimitOf(lock: LockEffect): number | null {
  const raw = lock.payload?.['limit'];
  return typeof raw === 'number' ? raw : null;
}

const allOwnPokemonFilterOf = (lock: LockEffect): CardFilter | null => {
  const raw = lock.payload?.['requiresAllOwnPokemon'];
  return raw && typeof raw === 'object' ? (raw as CardFilter) : null;
};

/**
 * attackDamageImmunity が **誰を守るか**（T43）。
 *   'self'（既定） … 宣言しているポケモン自身（ジュナイパー）
 *   'bench'        … 自分のベンチ全員（マナフィのなみのヴェール）
 *   'active'       … バトル場
 *   'all'          … 自分の場すべて
 * ★カードごとの分岐を増やさないための、対象側のセレクタ。
 *   `scope.filter` は攻撃側にかかるので、守る側はこちらで指す。
 */
export type ProtectScope = 'self' | 'bench' | 'active' | 'all';

const protectScopeOf = (lock: LockEffect): ProtectScope => {
  const raw = lock.payload?.['protects'];
  return raw === 'bench' || raw === 'active' || raw === 'all' ? raw : 'self';
};

// ── 旧 continuous 宣言からの取り込み ──────

/**
 * 第3段階までの `continuous` によるロック宣言を、統一表現へ読み替える。
 *
 * ★既存のカードデータを書き換えずに済ませるための橋。
 *   新しいカードは `locks` に直接書く。判定はどちらも同じ道を通る。
 */
export function lockFromContinuous(effect: {
  kind: string;
  scope: 'all' | 'self' | 'opponent';
  [key: string]: unknown;
}): LockEffect | null {
  const player = effect.scope === 'all' ? 'both' : effect.scope;
  const base = { exceptSelf: false, requiresActive: false } as const;

  switch (effect.kind) {
    case 'lockAbilities':
      return {
        kind: 'abilityLock',
        scope: { player, filter: (effect['filter'] as CardFilter | undefined) ?? {} },
        ...base,
      };
    case 'lockCardKind':
      return {
        kind: 'cardKindLock',
        scope: { player, filter: {} },
        ...base,
        payload: { trainerKind: effect['trainerKind'] },
      };
    case 'benchLimit':
      return {
        kind: 'benchLimit',
        scope: { player, filter: {} },
        ...base,
        payload: { limit: effect['limit'] },
      };
    /*
     * ★ダストオキシン（どうぐの効果をなくす）も特別扱いしない。
     *   「ポケモンのどうぐというカードの効果が止まる」＝ 対象がどうぐの abilityLock。
     *   exceptSelf: false ―― 自分についているどうぐも止まる。
     */
    case 'nullifyTools':
      return {
        kind: 'abilityLock',
        scope: { player, filter: { supertype: ['trainer'], trainerKind: ['tool'] } },
        ...base,
        label: 'ポケモンのどうぐの効果がなくなる',
      };
    default:
      return null;
  }
}

// ── 1. 素の盤面からロックを集める ─────────

/**
 * 場に出ているカードのうち、ロック効果を宣言しているものを全部集める。
 *
 * ★**素の盤面**から集める。ここで他のロックを一切考慮しないのが §2.1 の1パス評価。
 *   だからこの関数は他のロック判定関数を呼ばない（呼ぶと堂々巡りになる）。
 */
export function collectLocks(state: GameState, ctx: RuleContext = {}): LockSource[] {
  const out: LockSource[] = [];

  const push = (instanceId: string | null, controllerId: PlayerId, slotId: SlotId | null): void => {
    if (!instanceId) return;
    const instance = state.cards[instanceId];
    if (!instance || instance.functionalId === '') return;
    const card = ctx.cards?.byFunctionalId.get(instance.functionalId);
    if (!card) return;
    const declared: LockEffect[] = [
      ...(card.locks ?? []),
      ...((card.continuous ?? [])
        .map((effect) => lockFromContinuous(effect as never))
        .filter((lock): lock is LockEffect => lock !== null)),
    ];
    for (const lock of declared) out.push({ lock, instanceId, card, controllerId, slotId });
  };

  for (const [playerId, player] of Object.entries(state.players)) {
    for (const slot of player.pokemon) {
      // 特性を持つのは進化スタックの一番上だけ
      push(slot.stack[slot.stack.length - 1] ?? null, playerId, slot.slotId);
      if (slot.attachedTool) push(slot.attachedTool, playerId, slot.slotId);
      for (const energyId of slot.attachedEnergy) push(energyId, playerId, slot.slotId);
    }
  }
  if (state.stadium) {
    const owner = state.cards[state.stadium]?.ownerId;
    if (owner) push(state.stadium, owner, null);
  }

  return out.filter((source) => sourceIsActive(state, source, ctx));
}

/**
 * その発生源が、いま条件を満たしてはたらいているか。
 * ★これは発生源側の条件。相手側の条件（filter）とは別。
 */
function sourceIsActive(state: GameState, source: LockSource, ctx: RuleContext): boolean {
  // バトル場にいるときだけ（ガラルマタドガス / オーロット）
  if (source.lock.requiresActive && source.slotId !== 'active') return false;

  // 自分の場のポケモンが全部この条件に合うときだけ（ムゲンダイナVMAX の「悪ポケモンだけなら」）
  const requiresAll = allOwnPokemonFilterOf(source.lock);
  if (requiresAll) {
    const own = state.players[source.controllerId]?.pokemon ?? [];
    const tops = own
      .map((slot) => slot.stack[slot.stack.length - 1])
      .filter((id): id is string => Boolean(id));
    if (tops.length === 0) return false;
    const allMatch = tops.every((id) => {
      const instance = state.cards[id];
      const card = instance ? ctx.cards?.byFunctionalId.get(instance.functionalId) : undefined;
      return matchesCardFilter(card, requiresAll);
    });
    if (!allMatch) return false;
  }
  return true;
}

// ── 2〜3. 合成して判定する ────────────────

/** そのロックの scope が、対象プレイヤーに及ぶか */
function scopeCoversPlayer(source: LockSource, targetId: PlayerId): boolean {
  switch (source.lock.scope.player) {
    case 'both':
      return true;
    case 'self':
      return source.controllerId === targetId;
    case 'opponent':
      return source.controllerId !== targetId;
  }
}

/** 条件が空（＝全部が対象）か。カードの正体が分からなくても効かせてよい印 */
const filterIsUniversal = (filter: CardFilter): boolean => Object.keys(filter).length === 0;

/**
 * 判定の細かい振る舞い。
 * ★`requireExplicitFilter` は「条件を書いていないロックを対象外にする」印。
 *   条件が空のロック（ガラルマタドガス）は **場のポケモン** を指している。
 *   どうぐの効果まで止めたければ、ダストオキシンのように条件でどうぐを名指しする。
 *   ポケモン以外を判定するときにだけ立てる。
 */
export interface LockJudgeOptions {
  requireExplicitFilter?: boolean;
}

/**
 * ロック1つが、対象1つに効くか。
 * ★ここが「種類ごとに個別実装しない」の実体。kind によらず同じ判定を通す。
 */
export function lockHits(
  source: LockSource,
  target: LockTarget,
  options: LockJudgeOptions = {},
): boolean {
  if (!scopeCoversPlayer(source, target.playerId)) return false;
  // ★及ぶ場所。宣言がなければ場だけ（T43）
  const zones = source.lock.scope.zones ?? ['field'];
  if (!zones.includes(target.zone ?? 'field')) return false;
  // 発生源のカード自身をのぞく（ガラルマタドガス）
  if (source.lock.exceptSelf && target.instanceId && source.instanceId === target.instanceId) {
    return false;
  }
  const filter = source.lock.scope.filter;
  if (filterIsUniversal(filter)) return !options.requireExplicitFilter;
  // ★正体が分からないカードは条件に「合う」と扱わない（cardFilter と同じ考え方）
  return matchesCardFilter(target.card, filter);
}

/**
 * ある種類のロックについて、対象への答えを出す。
 *
 * ★§2.1 の警告つき。ロック効果が場に2つ以上あるなら、
 *   影響を受けている対象は ASSISTED に落とす（相互作用を自動で解かない）。
 */
export function judgeLock(
  state: GameState,
  kind: LockKind,
  target: LockTarget,
  ctx: RuleContext = {},
  collected?: readonly LockSource[],
  options: LockJudgeOptions = {},
): LockVerdict {
  const all = collected ?? collectLocks(state, ctx);
  const hits = all.filter(
    (source) => source.lock.kind === kind && lockHits(source, target, options),
  );
  if (hits.length === 0) return NO_LOCK;

  const sources = hits.map((source) => source.card.name);
  return {
    locked: true,
    assisted: all.length >= 2,
    reason: `${sources.join(' / ')}で${hits.map(describeLock).join(' / ')}`,
    sources,
  };
}

// ── 4. 種類ごとの呼び口（判定そのものは上の1本） ──

const topOf = (
  state: GameState,
  playerId: PlayerId,
  slotId: SlotId,
  ctx: RuleContext,
): { instanceId: string | null; card: CardText | undefined } => {
  const slot = state.players[playerId]?.pokemon.find((entry) => entry.slotId === slotId);
  const topId = slot?.stack[slot.stack.length - 1] ?? null;
  const instance = topId ? state.cards[topId] : undefined;
  const card =
    instance && instance.functionalId !== ''
      ? ctx.cards?.byFunctionalId.get(instance.functionalId)
      : undefined;
  return { instanceId: topId, card };
};

/**
 * そのポケモンの特性が止まっているか。
 * ★判定は **場に出ているポケモン（＝進化スタックの一番上）** で行う。
 *   BREAKなら、下から引きついだ特性もBREAK側の条件で止まる。
 */
export function abilityLockOn(
  state: GameState,
  playerId: PlayerId,
  slotId: SlotId,
  ctx: RuleContext = {},
  collected?: readonly LockSource[],
): LockVerdict {
  const { instanceId, card } = topOf(state, playerId, slotId, ctx);
  return judgeLock(state, 'abilityLock', { playerId, slotId, instanceId, card }, ctx, collected);
}

/**
 * ついているどうぐの効果が止まっているか（ダストオキシン）。
 * ★どうぐも「カードの効果が止まる」なので abilityLock で表す。
 */
export function toolLockOn(
  state: GameState,
  playerId: PlayerId,
  slotId: SlotId,
  toolInstanceId: string,
  ctx: RuleContext = {},
  collected?: readonly LockSource[],
): LockVerdict {
  const instance = state.cards[toolInstanceId];
  const card =
    instance && instance.functionalId !== ''
      ? ctx.cards?.byFunctionalId.get(instance.functionalId)
      : undefined;
  return judgeLock(
    state,
    'abilityLock',
    { playerId, slotId, instanceId: toolInstanceId, card },
    ctx,
    collected,
    // ★どうぐを止めるには、条件でどうぐを名指ししている必要がある
    { requireExplicitFilter: true },
  );
}

/**
 * そのプレイヤーがそのカード種別を使えるか。
 *
 * ★盤面のロック（ラフレシア / オーロット）と、
 *   かかっている効果（ガマゲロゲEX の げこげこアタック）の両方を見る。
 *   後者は「一度かかったら残る」ので ActiveEffect 側にある（§3.2）。
 */
export function cardKindLockOn(
  state: GameState,
  playerId: PlayerId,
  kind: TrainerKind,
  ctx: RuleContext = {},
  card?: CardText | undefined,
  collected?: readonly LockSource[],
): LockVerdict {
  const all = collected ?? collectLocks(state, ctx);
  const target: LockTarget = { playerId, slotId: null, instanceId: null, card };

  const hits = all.filter((source) => {
    if (source.lock.kind !== 'cardKindLock') return false;
    const byKind = trainerKindsOf(source.lock).includes(kind);
    // ★種別で指せないもの（特殊エネルギー等）はカードそのものへの条件で見る
    const playFilter = playFilterOf(source.lock);
    const byCard = Boolean(playFilter && card && matchesCardFilter(card, playFilter));
    if (!byKind && !byCard) return false;
    // ★カードそのものが分かっていなくても、条件が空なら効く
    if (!filterIsUniversal(source.lock.scope.filter) && card === undefined) return false;
    return lockHits(source, target);
  });

  const fromEffects = effectsOnPlayer(state, playerId).filter((effect) => {
    if (effect.kind !== 'lockCardKind') return false;
    const kinds = effect.payload['trainerKind'];
    return Array.isArray(kinds) && kinds.includes(kind);
  });

  if (hits.length === 0 && fromEffects.length === 0) return NO_LOCK;

  const sources = [...hits.map((s) => s.card.name), ...fromEffects.map((e) => e.source.label)];
  return {
    locked: true,
    assisted: all.length >= 2 && hits.length > 0,
    reason: `${sources.join(' / ')}で${TRAINER_KIND_LABEL[kind]}が使えない`,
    sources,
  };
}

/**
 * ★そのカードを今この人が出せるか（T43）。
 *
 *   トレーナーズ  … 種別（グッズ・サポート・スタジアム・どうぐ）で止まる
 *   エネルギー等  … `payload.filter` で止まる（シャドーミストの特殊エネルギー）
 *
 * 手札を暗くする表示（§4.1）と、rules の警告の両方がここを通る。
 */
export function playLockFor(
  state: GameState,
  playerId: PlayerId,
  card: CardText | undefined,
  ctx: RuleContext = {},
  collected?: readonly LockSource[],
): LockVerdict {
  if (!card) return NO_LOCK;
  if (card.supertype === 'trainer' && card.trainerKind) {
    return cardKindLockOn(state, playerId, card.trainerKind, ctx, card, collected);
  }
  const all = collected ?? collectLocks(state, ctx);
  const target: LockTarget = { playerId, slotId: null, instanceId: null, card };
  const hits = all.filter((source) => {
    if (source.lock.kind !== 'cardKindLock') return false;
    const playFilter = playFilterOf(source.lock);
    return Boolean(playFilter && matchesCardFilter(card, playFilter)) && lockHits(source, target);
  });

  // ★ワザでかけたぶん（シャドーミストの特殊エネルギー）も同じ窓口で見る
  const fromEffects = effectsOnPlayer(state, playerId).filter((effect) => {
    if (effect.kind !== 'lockCardKind') return false;
    const raw = effect.payload['filter'];
    return Boolean(raw && typeof raw === 'object' && matchesCardFilter(card, raw as CardFilter));
  });

  if (hits.length === 0 && fromEffects.length === 0) return NO_LOCK;
  const sources = [...hits.map((s) => s.card.name), ...fromEffects.map((e) => e.source.label)];
  return {
    locked: true,
    assisted: all.length >= 2,
    reason: `${sources.join(' / ')}で「${card.name}」は出せません`,
    sources,
  };
}

/** そのポケモンがワザを使えないか（メガニウム）。★貫通ワザも通らない */
export function attackLockOn(
  state: GameState,
  playerId: PlayerId,
  slotId: SlotId,
  ctx: RuleContext = {},
  collected?: readonly LockSource[],
): LockVerdict {
  const { instanceId, card } = topOf(state, playerId, slotId, ctx);
  return judgeLock(state, 'attackLock', { playerId, slotId, instanceId, card }, ctx, collected);
}

/**
 * 受ける側が、その攻撃側からのワザのダメージを受けないか（ジュナイパー）。
 *
 * ★宣言しているのは **受ける側** のカードで、条件は **攻撃側** のカードにかかる。
 *   「このポケモンは、相手のたねポケモンからワザのダメージを受けない」の形。
 *   だから scope.player は self（自分の場のポケモンを守る）にし、
 *   filter は攻撃側のカードに当てる。
 */
export function attackDamageImmunity(
  state: GameState,
  defender: { playerId: PlayerId; slotId: SlotId },
  attacker: { playerId: PlayerId; slotId: SlotId },
  ctx: RuleContext = {},
  collected?: readonly LockSource[],
): LockVerdict {
  const all = collected ?? collectLocks(state, ctx);
  const attackerCard = topOf(state, attacker.playerId, attacker.slotId, ctx);
  const defenderTop = topOf(state, defender.playerId, defender.slotId, ctx);

  const hits = all.filter((source) => {
    if (source.lock.kind !== 'attackDamageImmunity') return false;
    // 守られるポケモンの側（scope.player は宣言者から見た向き）
    if (!scopeCoversPlayer(source, defender.playerId)) return false;
    // ★誰を守るか。既定は宣言しているポケモン自身
    switch (protectScopeOf(source.lock)) {
      case 'self':
        if (source.slotId !== null && source.slotId !== defender.slotId) return false;
        break;
      case 'bench':
        if (defender.slotId === 'active') return false;
        break;
      case 'active':
        if (defender.slotId !== 'active') return false;
        break;
      case 'all':
        break;
    }
    if (source.lock.exceptSelf && source.instanceId === defenderTop.instanceId) return false;
    const filter = source.lock.scope.filter;
    if (filterIsUniversal(filter)) return true;
    return matchesCardFilter(attackerCard.card, filter);
  });

  if (hits.length === 0) return NO_LOCK;
  const sources = hits.map((source) => source.card.name);
  return {
    locked: true,
    assisted: all.length >= 2,
    reason: `${sources.join(' / ')} でワザのダメージを受けません`,
    sources,
  };
}

/**
 * ベンチ上限。
 * ★**最小値を採る**（§2.3）。スカイフィールド8 と ウソッキー4 が同時なら 4。
 * 宣言が1つもなければ null（呼び出し側が既定値を使う）。
 */
export function benchLimitFrom(
  state: GameState,
  playerId: PlayerId,
  ctx: RuleContext = {},
  collected?: readonly LockSource[],
): { limit: number; sources: string[] } | null {
  const all = collected ?? collectLocks(state, ctx);
  const target: LockTarget = { playerId, slotId: null, instanceId: null, card: undefined };
  const hits = all.filter(
    (source) => source.lock.kind === 'benchLimit' && lockHits(source, target),
  );
  const limits = hits
    .map((source) => benchLimitOf(source.lock))
    .filter((n): n is number => n !== null);
  if (limits.length === 0) return null;
  return { limit: Math.min(...limits), sources: hits.map((source) => source.card.name) };
}

// ── ★複数ロックの警告（§2.1 / §4.5） ─────────

export interface MultipleLockWarning {
  /** 場に出ているロック効果 */
  locks: LockSource[];
  /** 2つ以上あるか。true のあいだ、消えないバナーを出す（§4.5） */
  multiple: boolean;
  /** そのまま画面に出す一行 */
  message: string;
  /** 「頂への雪道（相手 / ルールを持つポケモンの特性）」のような列挙 */
  details: string[];
}

export function multipleLockWarning(
  state: GameState,
  ctx: RuleContext = {},
  collected?: readonly LockSource[],
): MultipleLockWarning {
  const locks = [...(collected ?? collectLocks(state, ctx))];
  const details = locks.map((source) => `${source.card.name}（${describeLock(source)}）`);
  return {
    locks,
    multiple: locks.length >= 2,
    message:
      locks.length >= 2
        ? 'ロック効果が2つ以上出ています。重なった部分は自動判定しません（要確認）'
        : '',
    details,
  };
}
