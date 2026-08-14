/**
 * 効果インタプリタ（第3段階 §2.1 / T24）。
 *
 * ★ジェネレータを使わない。
 *   `yield` で書けば素直だが、ジェネレータの実行位置はシリアライズできない。
 *   実行位置を「cursor という ただの数」で持つことで、実行途中の状態もそのまま
 *   JSON にでき、第2段階で作った再接続・永続化（T22）とリプレイ（§4.2）が成立する。
 *
 * ★if / repeat を再帰で実行しない。
 *   条件が通った枝を **ops 列の cursor の直後に差し込む**（展開）。
 *   cursor は前にしか進まないので、途中で保存しても位置がずれない。
 *   静的に決まる repeat（回数がリテラル）は実行前に展開しておく。
 *
 * ★乱数はここで振らない（§4.2）。
 *   シャッフルの並びやコインの結果は EffectRolls として渡ってくる。
 *   サーバーが先に決めて Action に載せるので、ログから同じ盤面を再現できる。
 */
import { cardsInZoneOf, relocate, syncSlotZones } from './board';
import { instantiateEffect } from './effects';
import { matchesCardFilter } from './cardFilter';
import type { CardIndex } from './cards';
import { getBenchLimit, isImmuneToEffectFrom } from './derived';
import type {
  ChoiceRequest,
  Condition,
  CountSource,
  CountValue,
  EffectExecution,
  EffectSource,
  Op,
  PlayerRef,
  SlotFilter,
  SlotRef,
} from './dsl';
import type { RuleContext } from './rules';
import type {
  CardInstance,
  CardText,
  GameState,
  PlayerId,
  PokemonInPlay,
  SlotId,
  Zone,
} from './types';

/** 展開しすぎて状態が肥大化しないための上限。無限ループの歯止めも兼ねる */
export const MAX_EXPANDED_OPS = 512;

/** 選択を頼むときの文面に使う */
const ZONE_LABEL: Record<Zone, string> = {
  deck: '山札',
  hand: '手札',
  active: 'バトル場',
  bench: 'ベンチ',
  prize: 'サイド',
  discard: 'トラッシュ',
  lost: 'ロストゾーン',
  stadium: 'スタジアム',
};

export class EffectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EffectError';
  }
}

/**
 * この1歩で使う乱数の結果。サーバーが先に決めて渡す（§4.2）。
 * ★結果を Action に載せて配るので、同じログからは必ず同じ盤面になる。
 */
export interface EffectRolls {
  /** shuffle 用の新しい並び。index 0 が山札の一番上 */
  order?: string[];
  /** coinFlip の結果 */
  coins?: ('heads' | 'tails')[];
}

// ── 参照の解決 ────────────────────────

/** 効果から見た PlayerRef を実際のプレイヤーに解決する */
export function resolvePlayerRef(
  state: GameState,
  self: PlayerId,
  ref: PlayerRef,
): PlayerId[] {
  const others = Object.keys(state.players).filter((id) => id !== self);
  switch (ref) {
    case 'self':
      return [self];
    case 'opponent':
      return others;
    case 'both':
      return [self, ...others];
  }
}

/** 1人に決まる場面で使う。決まらなければ undefined */
export function resolveSinglePlayer(
  state: GameState,
  self: PlayerId,
  ref: PlayerRef,
): PlayerId | undefined {
  return resolvePlayerRef(state, self, ref)[0];
}

/**
 * SlotRef を実際のスロットへ。
 * choose は選択が要るのでここでは解決しない（呼び出し側が pendingChoice を立てる）。
 */
export function resolveSlotRef(
  state: GameState,
  execution: EffectExecution,
  ref: SlotRef,
): { playerId: PlayerId; slotId: SlotId }[] {
  const self = execution.source.playerId;
  switch (ref.kind) {
    case 'active':
      return resolvePlayerRef(state, self, ref.player)
        .filter((id) => state.players[id]?.pokemon.some((p) => p.slotId === 'active'))
        .map((playerId) => ({ playerId, slotId: 'active' as SlotId }));
    case 'bench':
      return resolvePlayerRef(state, self, ref.player).flatMap((playerId) => {
        const bench = (state.players[playerId]?.pokemon ?? []).filter((p) => p.slotId !== 'active');
        const picked =
          ref.index === undefined ? bench : bench.filter((p) => p.slotId === `bench-${ref.index}`);
        return picked.map((p) => ({ playerId, slotId: p.slotId }));
      });
    case 'self': {
      const instanceId = execution.source.instanceId;
      if (!instanceId) return [];
      for (const [playerId, player] of Object.entries(state.players)) {
        const slot = player.pokemon.find((p) => p.stack.includes(instanceId));
        if (slot) return [{ playerId, slotId: slot.slotId }];
      }
      return [];
    }
    case 'binding': {
      const value = execution.bindings[ref.name];
      return Array.isArray(value)
        ? (value as { playerId: PlayerId; slotId: SlotId }[])
        : [];
    }
    case 'choose':
      // 選択が必要。呼び出し側が ChoiceRequest を立てる
      return [];
  }
}

/** 場のポケモン1匹が SlotFilter に合うか */
export function matchesSlotFilter(
  state: GameState,
  slot: PokemonInPlay,
  filter: SlotFilter | undefined,
  ctx: RuleContext = {},
): boolean {
  if (!filter) return true;
  if (filter.where === 'active' && slot.slotId !== 'active') return false;
  if (filter.where === 'bench' && slot.slotId === 'active') return false;
  if (filter.hasDamage !== undefined && slot.damageCounters > 0 !== filter.hasDamage) return false;
  if (filter.hasEnergy !== undefined && slot.attachedEnergy.length > 0 !== filter.hasEnergy) {
    return false;
  }
  if (filter.hasTool !== undefined && (slot.attachedTool !== null) !== filter.hasTool) return false;
  if (filter.hasCondition !== undefined && slot.conditions.length > 0 !== filter.hasCondition) {
    return false;
  }
  if (filter.card) {
    // 進化スタックの一番上（＝いまそのポケモンが何であるか）で見る
    const topId = slot.stack[slot.stack.length - 1];
    const top = topId === undefined ? undefined : state.cards[topId];
    if (!top || !matchesCardFilter(cardTextOf(top, ctx.cards), filter.card)) return false;
  }
  return true;
}

/**
 * SlotRef が指しうるスロットの一覧。
 *
 * resolveSlotRef との違いは `choose` の扱いだけ。
 * resolveSlotRef は「まだ選ばれていない」ので空を返すが、こちらは **選択肢** を返す。
 * ★T29 の「状況が変化しないなら使えない」判定はこれが要る。
 *   「ダメカンがのっているポケモンを1匹選ぶ」で、候補が0匹なら状況は変わらない。
 */
export function slotCandidates(
  state: GameState,
  execution: EffectExecution,
  ref: SlotRef,
  ctx: RuleContext = {},
): { playerId: PlayerId; slotId: SlotId }[] {
  if (ref.kind !== 'choose') return resolveSlotRef(state, execution, ref);
  return resolvePlayerRef(state, execution.source.playerId, ref.player)
    .flatMap((playerId) =>
      (state.players[playerId]?.pokemon ?? [])
        .filter((slot) => matchesSlotFilter(state, slot, ref.filter, ctx))
        .map((slot) => ({ playerId, slotId: slot.slotId })),
    )
    // ★Ωバリア持ちは相手のトレーナーズの対象にならない（T39）
    .filter(({ playerId, slotId }) => !shieldedFromThisEffect(state, execution, playerId, slotId, ctx));
}

/**
 * ★そのスロットが、いま動いている効果の対象から外れるか（T39 → T44）。
 *
 * 「相手の●●の効果を受けない」は、
 *   - 発生源の種類が守っている対象と一致し
 *   - かつ **相手の** ポケモンを狙っている
 * ときだけはたらく。自分のポケモンに自分でどうぐをつけるのは妨げない。
 *
 *   Ωバリア / Θストップ   … トレーナーズから守る
 *   フュージョンエネルギー … 相手のポケモンの特性から守る
 */
export function shieldedFromThisEffect(
  state: GameState,
  execution: EffectExecution,
  playerId: PlayerId,
  slotId: SlotId,
  ctx: RuleContext = {},
): boolean {
  // 自分のポケモンなら「相手の効果」ではない
  if (playerId === execution.source.playerId) return false;
  const kind = effectSourceKind(state, execution, ctx);
  if (!kind) return false;
  return isImmuneToEffectFrom(state, playerId, slotId, kind, ctx);
}

/** いま動いている効果が「どこから出ているか」 */
function effectSourceKind(
  state: GameState,
  execution: EffectExecution,
  ctx: RuleContext,
): 'trainer' | 'ability' | 'attack' | null {
  // ★特性・ワザは発生源に番号が入っている（room が startEffect に載せる）
  if (execution.source.abilityIndex !== undefined) return 'ability';
  if (execution.source.attackIndex !== undefined) return 'attack';
  const sourceId = execution.source.instanceId;
  if (!sourceId) return null;
  const instance = state.cards[sourceId];
  if (!instance || instance.functionalId === '') return null;
  const card = ctx.cards?.byFunctionalId.get(instance.functionalId);
  return card?.supertype === 'trainer' ? 'trainer' : null;
}

const targetBinding = (execution: EffectExecution): string => `__target:${execution.cursor}`;

/**
 * いま止まっているオペコードの「つける先」。
 *
 * ★`choose` のときは選択の結果が bindings に入っているが、
 *   `self` や `active` のように **選ばせない指定** のときは何も入っていない。
 *   その場合は指定をそのまま解決し直す。
 *   （ここを忘れると、ザシアンVのふとうのつるぎのように
 *     「対象は自分自身・カードだけ選ばせる」効果が黙って何もしなくなる）
 */
function boundTarget(
  state: GameState,
  execution: EffectExecution,
  ref: SlotRef,
): { playerId: PlayerId; slotId: SlotId } | undefined {
  const bound = execution.bindings[targetBinding(execution)];
  if (Array.isArray(bound) && bound[0]) {
    return bound[0] as { playerId: PlayerId; slotId: SlotId };
  }
  return resolveSlotRef(state, execution, ref)[0];
}

function ensureChosenTarget(
  state: GameState,
  execution: EffectExecution,
  ref: SlotRef,
  ctx: RuleContext,
  prompt: string,
): { playerId: PlayerId; slotId: SlotId } | undefined {
  if (ref.kind !== 'choose') return resolveSlotRef(state, execution, ref)[0];
  const key = targetBinding(execution);
  const bound = execution.bindings[key];
  if (Array.isArray(bound) && bound[0]) return bound[0] as { playerId: PlayerId; slotId: SlotId };
  const candidates = slotCandidates(state, execution, ref, ctx);
  if (candidates.length === 0) {
    execution.cursor += 1;
    return undefined;
  }
  const chooser = resolveSinglePlayer(state, execution.source.playerId, ref.chooser) ?? execution.source.playerId;
  suspend(execution, {
    requestId: `${execution.executionId}-target${execution.cursor}`,
    chooser,
    kind: 'selectSlot',
    prompt,
    candidates: candidates.flatMap(({ playerId, slotId }) => {
      const slot = state.players[playerId]?.pokemon.find((entry) => entry.slotId === slotId);
      const top = slot?.stack.at(-1);
      return top ? [top] : [];
    }),
    min: 1,
    max: 1,
    temporarilyRevealed: [],
  });
  return undefined;
}

/** count は数のこともあれば bindings 由来のこともある */
export function resolveCount(
  execution: EffectExecution,
  count: CountValue,
  state?: GameState,
  ctx: RuleContext = {},
): number {
  if (typeof count === 'number') return count;
  if ('from' in count) return state ? countOf(state, execution, count.from, ctx) : 0;
  const value = execution.bindings[count.binding];
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) return value.length;
  return 0;
}

// ── 条件の評価 ────────────────────────

function countOf(
  state: GameState,
  execution: EffectExecution,
  source: CountSource,
  ctx: RuleContext,
): number {
  const self = execution.source.playerId;
  switch (source.source) {
    case 'zone': {
      const owners = resolvePlayerRef(state, self, source.owner);
      return Object.values(state.cards).filter(
        (c) =>
          owners.includes(c.ownerId) &&
          c.zone === source.zone &&
          (source.filter === undefined || matchesCardFilter(cardTextOf(c, ctx.cards), source.filter)),
      ).length;
    }
    case 'prizes':
      return resolvePlayerRef(state, self, source.player).reduce(
        (n, id) => n + (state.players[id]?.prizesRemaining ?? 0),
        0,
      );
    /** ★条件に合う場のポケモンの数（T44）。進化スタックの一番上で見る */
    case 'inPlay':
      return resolvePlayerRef(state, self, source.player).reduce((n, id) => {
        const slots = state.players[id]?.pokemon ?? [];
        return (
          n +
          slots.filter((slot) => {
            const topId = slot.stack[slot.stack.length - 1];
            const instance = topId ? state.cards[topId] : undefined;
            if (!instance) return false;
            if (source.filter === undefined) return true;
            return matchesCardFilter(cardTextOf(instance, ctx.cards), source.filter);
          }).length
        );
      }, 0);
    case 'bench':
      return resolvePlayerRef(state, self, source.player).reduce(
        (n, id) => n + (state.players[id]?.pokemon.filter((p) => p.slotId !== 'active').length ?? 0),
        0,
      );
    case 'damageCounters':
      return resolveSlotRef(state, execution, source.target).reduce((n, { playerId, slotId }) => {
        const slot = state.players[playerId]?.pokemon.find((p) => p.slotId === slotId);
        return n + (slot?.damageCounters ?? 0);
      }, 0);
    case 'attachedEnergy':
      return resolveSlotRef(state, execution, source.target).reduce((n, { playerId, slotId }) => {
        const slot = state.players[playerId]?.pokemon.find((p) => p.slotId === slotId);
        return n + (slot?.attachedEnergy.length ?? 0);
      }, 0);
    case 'binding': {
      const value = execution.bindings[source.name];
      if (typeof value === 'number') return value;
      if (Array.isArray(value)) return value.length;
      return 0;
    }
  }
}

const compare = (left: number, op: string, right: number): boolean => {
  switch (op) {
    case 'eq':
      return left === right;
    case 'ne':
      return left !== right;
    case 'lt':
      return left < right;
    case 'lte':
      return left <= right;
    case 'gt':
      return left > right;
    case 'gte':
      return left >= right;
    default:
      return false;
  }
};

export function evaluateCondition(
  state: GameState,
  execution: EffectExecution,
  cond: Condition,
  ctx: RuleContext = {},
): boolean {
  switch (cond.kind) {
    case 'coin': {
      const value = execution.bindings[cond.binding];
      const faces = Array.isArray(value) ? (value as string[]) : [];
      const hits = faces.filter((f) => f === cond.face).length;
      return hits >= (cond.atLeast ?? 1);
    }
    case 'count':
      return compare(countOf(state, execution, cond.of, ctx), cond.compare, cond.value);
    case 'exists':
      return slotCandidates(state, execution, cond.slot, ctx).length > 0;
    case 'playersTurn': {
      const players = resolvePlayerRef(state, execution.source.playerId, cond.player);
      const turns = state.turnHistory.filter((turn) => players.includes(turn.playerId)).length;
      return compare(turns, cond.compare, cond.value);
    }
    case 'knockedOutLastOpponentTurn': {
      const players = resolvePlayerRef(state, execution.source.playerId, cond.player);
      const turnEnds = state.log
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.action.type === 'endTurn');
      const latest = turnEnds.at(-1)?.index;
      const previous = turnEnds.at(-2)?.index ?? -1;
      const window = latest === undefined ? state.log : state.log.slice(previous + 1, latest + 1);
      return window.some(
        (entry) => entry.action.type === 'knockOut' && players.includes(entry.action.playerId),
      );
    }
    case 'option':
      return execution.bindings[cond.binding] === cond.equals;
    case 'not':
      return !evaluateCondition(state, execution, cond.of, ctx);
    case 'and':
      return cond.of.every((c) => evaluateCondition(state, execution, c, ctx));
    case 'or':
      return cond.of.some((c) => evaluateCondition(state, execution, c, ctx));
  }
}

// ── 実行の作成 ────────────────────────

/**
 * 静的に決まるぶんだけ先に展開する。
 * 回数がリテラルの repeat はここで開いておく。
 * if と、回数が bindings 由来の repeat は実行時にしか決まらないので残す。
 */
export function flattenOps(ops: readonly Op[], budget = MAX_EXPANDED_OPS): Op[] {
  const out: Op[] = [];
  for (const op of ops) {
    if (out.length >= budget) throw new EffectError('効果の展開が大きすぎます');
    if (op.op === 'repeat' && typeof op.times === 'number') {
      const body = flattenOps(op.body, budget);
      for (let i = 0; i < op.times; i += 1) {
        out.push(...body);
        if (out.length > budget) throw new EffectError('効果の展開が大きすぎます');
      }
      continue;
    }
    if (op.op === 'if') {
      out.push({
        ...op,
        then: flattenOps(op.then, budget),
        ...(op.else ? { else: flattenOps(op.else, budget) } : {}),
      });
      continue;
    }
    out.push(op);
  }
  return out;
}

export function createExecution(options: {
  executionId: string;
  ops: readonly Op[];
  source: EffectSource;
  bindings?: Record<string, unknown>;
}): EffectExecution {
  return {
    executionId: options.executionId,
    ops: flattenOps(options.ops),
    cursor: 0,
    bindings: { ...(options.bindings ?? {}) },
    pendingChoice: null,
    source: options.source,
  };
}

/** 次に実行するオペコード。終わっていれば undefined */
export function currentOp(execution: EffectExecution | null): Op | undefined {
  if (!execution) return undefined;
  return execution.ops[execution.cursor];
}

/** いま進められるか（応答待ちでなく、まだオペコードが残っている） */
export function canStep(state: GameState): boolean {
  const execution = state.execution;
  if (!execution) return false;
  if (execution.pendingChoice) return false;
  return execution.cursor < execution.ops.length;
}

// ── 1歩進める ────────────────────────

/**
 * §2.1 の `step(state): GameState`。
 * 1回の呼び出しで **1オペコードだけ** 進める。
 *
 * ★純粋関数。渡された state は書き換えない。
 * ★applyAction の中（mutate）からも呼べるように、書き換え版 stepEffectInPlace を分けてある。
 */
export function stepEffect(
  state: GameState,
  rolls: EffectRolls = {},
  ctx: RuleContext = {},
): GameState {
  const next = structuredClone(state);
  stepEffectInPlace(next, rolls, ctx);
  return next;
}

/** state を直接書き換える版。applyAction の mutate から呼ぶ */
export function stepEffectInPlace(
  state: GameState,
  rolls: EffectRolls,
  ctx: RuleContext,
): void {
  const execution = state.execution;
  if (!execution) return;
  // 応答待ちの間は何も進めない（§3.3）
  if (execution.pendingChoice) return;

  const op = execution.ops[execution.cursor];
  if (op === undefined) {
    // 全部終わった
    state.execution = null;
    return;
  }

  runOp(state, execution, op, rolls, ctx);

  // 最後まで来ていて、応答待ちでもなければ実行を畳む
  if (state.execution && !state.execution.pendingChoice) {
    if (state.execution.cursor >= state.execution.ops.length) state.execution = null;
  }
}

// ── オペコードごとの処理 ──────────────

function runOp(
  state: GameState,
  execution: EffectExecution,
  op: Op,
  rolls: EffectRolls,
  ctx: RuleContext,
): void {
  const self = execution.source.playerId;

  switch (op.op) {
    // ── 制御構造（実行時に ops へ差し込む。再帰しない） ──
    case 'if': {
      const taken = evaluateCondition(state, execution, op.cond, ctx) ? op.then : (op.else ?? []);
      expandAt(execution, taken);
      execution.cursor += 1;
      return;
    }

    case 'repeat': {
      const times = resolveCount(execution, op.times, state, ctx);
      const body = flattenOps(op.body);
      const expanded: Op[] = [];
      for (let i = 0; i < times; i += 1) expanded.push(...body);
      expandAt(execution, expanded);
      execution.cursor += 1;
      return;
    }

    // ── 完了条件の3つ（T24） ──
    case 'draw': {
      const declared = resolveCount(execution, op.count, state, ctx);
      for (const playerId of resolvePlayerRef(state, self, op.player)) {
        /*
         * ★「手札が▲枚になるように引く」（T34）。
         *   引く枚数は人ごとに変わるので、プレイヤーを決めてから数える。
         *   すでに▲枚以上あれば1枚も引かない（マイナスにしない）。
         */
        const count =
          op.upToHandSize === undefined
            ? declared
            : Math.max(
                0,
                resolveCount(execution, op.upToHandSize, state, ctx) -
                  cardsInZoneOf(state, playerId, 'hand').length,
              );
        const deck = cardsInZoneOf(state, playerId, 'deck');
        for (const card of deck.slice(0, count)) {
          relocate(state, card.instanceId, 'hand', 'bottom', {
            visibleTo: [playerId],
            faceUp: false,
          });
        }
      }
      execution.cursor += 1;
      return;
    }

    case 'shuffle': {
      const owner = resolveSinglePlayer(state, self, op.owner);
      if (!owner) throw new EffectError('シャッフルする相手が決まりません');
      if (!rolls.order) throw new EffectError('シャッフルの並びが渡されていません');
      // ★並びはサーバーが決めたものをそのまま使う（§4.2）
      applyShuffleOrder(state, rolls.order);
      execution.cursor += 1;
      return;
    }

    case 'discard': {
      const owner = resolveSinglePlayer(state, self, op.owner);
      if (!owner) throw new EffectError('トラッシュする相手が決まりません');

      // lookAt があれば、その枚数だけを対象にする（キュワワーの「残りをトラッシュ」。T34）
      const source = cardsInZoneOf(state, owner, op.from);
      const eligible = source
        .slice(0, op.lookAt ?? source.length)
        .filter(
          (c) => op.filter === undefined || matchesCardFilter(cardTextOf(c, ctx.cards), op.filter),
        );
      const want = op.count === 'all' ? eligible.length : op.count;

      // 選ぶ余地がなければそのまま実行する。余地があるときだけ人に聞く
      if (op.count === 'all' || (!op.optional && eligible.length <= want)) {
        for (const card of eligible) relocate(state, card.instanceId, 'discard');
        if (op.bind) execution.bindings[op.bind] = eligible.map((card) => card.instanceId);
        execution.cursor += 1;
        return;
      }

      const chooser = resolveSinglePlayer(state, self, op.chooser) ?? owner;
      suspend(execution, {
        requestId: `${execution.executionId}-c${execution.cursor}`,
        chooser,
        kind: 'selectCards',
        prompt: `トラッシュするカードを${want}枚選んでください`,
        candidates: eligible.map((c) => c.instanceId),
        min: op.optional || op.upTo ? 0 : Math.min(want, eligible.length),
        max: want,
        temporarilyRevealed: [],
        ...(op.optional ? { allowedCounts: [0, want] } : {}),
      });
      return;
    }

    case 'coinFlip': {
      const coins = rolls.coins ?? [];
      if (coins.length === 0) throw new EffectError('コインの結果が渡されていません');
      execution.bindings[op.bind] = [...coins];
      execution.cursor += 1;
      return;
    }

    case 'chooseOption': {
      const chooser = resolveSinglePlayer(state, self, op.chooser) ?? self;
      suspend(execution, {
        requestId: `${execution.executionId}-o${execution.cursor}`,
        chooser,
        kind: 'selectOption',
        prompt: '使う効果を選んでください',
        candidates: op.options.map((option) => option.id),
        min: 1,
        max: 1,
        temporarilyRevealed: [],
        optionLabels: Object.fromEntries(op.options.map((option) => [option.id, option.label])),
      });
      return;
    }

    case 'clearEffects': {
      state.effects = op.source === 'all'
        ? []
        : state.effects.filter((effect) => effect.source.attackIndex === undefined);
      execution.cursor += 1;
      return;
    }

    case 'moveCard': {
      const owners = resolvePlayerRef(state, self, op.owner);
      const owner = owners[0];
      if (!owner) throw new EffectError('カードを動かすプレイヤーが決まりません');
      const eligible = owners.flatMap((id) => eligibleZoneCards(state, id, op.from)).filter(
        (card) => {
          if (op.filter !== undefined && !matchesCardFilter(cardTextOf(card, ctx.cards), op.filter)) return false;
          const slot = state.players[card.ownerId]?.pokemon.find((entry) =>
            entry.stack.at(-1) === card.instanceId ||
            entry.attachedTool === card.instanceId ||
            entry.attachedEnergy.includes(card.instanceId),
          );
          // ★Ωバリア持ちについているカードは、相手のトレーナーズで外せない（T39）
          if (slot && shieldedFromThisEffect(state, execution, card.ownerId, slot.slotId, ctx)) {
            return false;
          }
          if (!op.slotFilter) return true;
          return !!slot && matchesSlotFilter(state, slot, op.slotFilter, ctx);
        },
      );
      const want = op.count === 'all' ? eligible.length : Math.min(op.count, eligible.length);
      if (op.count === 'all' || (!op.upTo && eligible.length <= want)) {
        const picked = eligible.slice(0, want).map((card) => card.instanceId);
        movePicked(state, picked, op.to, op.position, op.includeAttached);
        if (op.bind) execution.bindings[op.bind] = picked;
        execution.cursor += 1;
        return;
      }
      const chooser = resolveSinglePlayer(state, self, op.chooser) ?? owner;
      suspend(execution, {
        requestId: `${execution.executionId}-v${execution.cursor}`,
        chooser,
        kind: 'selectCards',
        prompt: `${op.from === 'inPlay' || op.from === 'field' ? '場' : ZONE_LABEL[op.from]}から${want}枚選んでください`,
        candidates: eligible.map((card) => card.instanceId),
        min: op.upTo ? 0 : want,
        max: want,
        temporarilyRevealed: [],
      });
      return;
    }

    /**
     * 山札などから条件に合うカードを選んで移す（T25）。
     *
     * ★選ぶ側にだけ中身を一時公開してから聞く。
     *   実際に移すのは応答が返ってきたとき（resolveChoiceInPlace）。
     */
    case 'search': {
      const owner = resolveSinglePlayer(state, self, op.owner);
      if (!owner) throw new EffectError('サーチする相手が決まりません');
      const chooser = resolveSinglePlayer(state, self, op.chooser) ?? owner;

      // 山札から直接ベンチへ出す効果は、置き場所がなければ山札を見ずに終える。
      // ワザなら宣言自体はできるが、非公開情報まで見られるわけではない（T29）。
      if (op.dest === 'bench' && op.destSlot?.kind === 'bench') {
        const destination = op.destSlot;
        const destinationPlayers = resolvePlayerRef(state, self, destination.player);
        const hasRoom = destinationPlayers.some((playerId) => {
          const pokemon = state.players[playerId]?.pokemon ?? [];
          const limit = getBenchLimit(state, playerId, ctx);
          const bench = pokemon.filter((slot) => slot.slotId !== 'active');
          if (bench.length >= limit) return false;
          if (destination.index === undefined) return true;
          return (
            destination.index < limit &&
            !bench.some((slot) => slot.slotId === `bench-${destination.index}`)
          );
        });
        if (!hasRoom) {
          execution.cursor += 1;
          return;
        }
      }

      const sourceCards = cardsInZoneOf(state, owner, op.from);
      const eligible = sourceCards.slice(0, op.lookAt ?? sourceCards.length).filter((c) =>
        matchesCardFilter(cardTextOf(c, ctx.cards), op.filter),
      );

      // 条件に合うカードがなければ、何も起きずに次へ（ワザは宣言できる。T29 で詳しく）
      if (eligible.length === 0) {
        if (op.thenShuffle && rolls.order) applyShuffleOrder(state, rolls.order);
        execution.cursor += 1;
        return;
      }

      const benchCapacity = op.dest === 'bench'
        ? Math.max(
            0,
            getBenchLimit(state, owner, ctx) -
              (state.players[owner]?.pokemon.filter((slot) => slot.slotId !== 'active').length ?? 0),
          )
        : Number.POSITIVE_INFINITY;
      const max = Math.min(op.count, eligible.length, benchCapacity);
      // ★「▲▲まで」なら0枚も許す。そうでなければ指定枚数を必ず選ばせる（§3.3）
      const min = op.upTo ? 0 : max;

      // 選ぶ側にだけ中身を見せる。もともと見えていたカードは記録しない（戻すときに剥がさないため）
      const revealed: string[] = [];
      for (const card of eligible) {
        if (card.visibleTo.includes(chooser)) continue;
        card.visibleTo = [...card.visibleTo, chooser];
        revealed.push(card.instanceId);
      }

      suspend(execution, {
        requestId: `${execution.executionId}-s${execution.cursor}`,
        chooser,
        kind: 'selectCards',
        prompt: `${ZONE_LABEL[op.from]}から${op.upTo ? `${max}枚まで` : `${max}枚`}選んでください`,
        candidates: eligible.map((c) => c.instanceId),
        min,
        max,
        temporarilyRevealed: revealed,
      });
      return;
    }

    case 'attachEnergy': {
      const owner = self;
      const target = ensureChosenTarget(state, execution, op.target, ctx, 'エネルギーをつけるポケモン');
      if (!target) return;
      const sourceCards = cardsInZoneOf(state, owner, op.from);
      const eligible = sourceCards.slice(0, op.lookAt ?? sourceCards.length).filter((card) =>
        matchesCardFilter(cardTextOf(card, ctx.cards), op.filter),
      );
      if (eligible.length === 0) {
        if (op.thenShuffle && rolls.order) applyShuffleOrder(state, rolls.order);
        execution.cursor += 1;
        return;
      }
      const max = Math.min(op.count, eligible.length);
      suspend(execution, {
        requestId: `${execution.executionId}-a${execution.cursor}`,
        chooser: owner,
        kind: 'selectCards',
        prompt: `${ZONE_LABEL[op.from]}からエネルギーを${op.upTo ? `${max}枚まで` : `${max}枚`}選んでください`,
        candidates: eligible.map((card) => card.instanceId),
        min: op.upTo ? 0 : max,
        max,
        temporarilyRevealed: [],
      });
      return;
    }

    case 'switch': {
      const player = op.side === 'own'
        ? self
        : resolveSinglePlayer(state, self, 'opponent');
      if (!player) {
        execution.cursor += 1;
        return;
      }
      const bench = (state.players[player]?.pokemon ?? [])
        .filter((slot) => slot.slotId !== 'active')
        // ★Ωバリア持ちは相手のトレーナーズで引きずり出せない（T39）
        .filter((slot) => !shieldedFromThisEffect(state, execution, player, slot.slotId, ctx));
      if (bench.length === 0) {
        execution.cursor += 1;
        return;
      }
      const chooser = resolveSinglePlayer(state, self, op.chooser) ?? self;
      suspend(execution, {
        requestId: `${execution.executionId}-switch${execution.cursor}`,
        chooser,
        kind: 'selectSlot',
        prompt: `${op.side === 'own' ? '自分' : '相手'}のベンチポケモンを選んでください`,
        candidates: bench.flatMap((slot) => {
          const top = slot.stack.at(-1);
          return top ? [top] : [];
        }),
        min: 1,
        max: 1,
        temporarilyRevealed: [],
      });
      return;
    }

    case 'evolve': {
      const owner = resolveSinglePlayer(state, self, op.player);
      if (!owner) throw new EffectError('進化するプレイヤーが決まりません');
      const target = ensureChosenTarget(state, execution, op.target, ctx, '進化させるポケモン');
      if (!target) return;
      const slot = state.players[target.playerId]?.pokemon.find((entry) => entry.slotId === target.slotId);
      const top = slot?.stack.at(-1);
      const topText = top ? cardTextOf(state.cards[top]!, ctx.cards) : undefined;
      if (!slot || !topText) {
        execution.cursor += 1;
        return;
      }
      const eligible = cardsInZoneOf(state, owner, op.from).filter((card) => {
        const text = cardTextOf(card, ctx.cards);
        if (!text || (op.filter && !matchesCardFilter(text, op.filter))) return false;
        if (text.evolvesFrom === topText.name) return true;
        if (!op.skipStage1 || text.stage !== 'stage2' || !text.evolvesFrom) return false;
        return (ctx.cards?.byName.get(text.evolvesFrom) ?? []).some(
          (middle) => middle.stage === 'stage1' && middle.evolvesFrom === topText.name,
        );
      });
      if (eligible.length === 0) {
        if (op.thenShuffle && rolls.order) applyShuffleOrder(state, rolls.order);
        execution.cursor += 1;
        return;
      }
      const revealed: string[] = [];
      for (const card of eligible) {
        if (!card.visibleTo.includes(owner)) {
          card.visibleTo = [...card.visibleTo, owner];
          revealed.push(card.instanceId);
        }
      }
      suspend(execution, {
        requestId: `${execution.executionId}-evolve${execution.cursor}`,
        chooser: owner,
        kind: 'selectCards',
        prompt: '進化させるカードを1枚選んでください',
        candidates: eligible.map((card) => card.instanceId),
        min: 1,
        max: 1,
        temporarilyRevealed: revealed,
      });
      return;
    }

    /**
     * ダメカンをのせる / 取り除く（T28 の注意6）。
     *
     * ★これは **ダメージではない**。
     *   弱点・抵抗力・軽減効果を一切通さないので、
     *   ダメージ計算パイプライン（damageCalculation.ts）を **呼ばない**。
     */
    case 'damageCounter': {
      // 配分やダメカンの移動は人が選ぶ必要がある。自動化は T31 以降
      if (op.distribution !== 'single' || op.action === 'move') break;

      // 「相手のベンチポケモンを1匹選び」（かがやくルチャブル等。T34）
      const chosen = ensureChosenTarget(
        state,
        execution,
        op.target,
        ctx,
        `ダメカンを${op.count}個のせるポケモン`,
      );
      const targets = op.target.kind === 'choose'
        ? (chosen ? [chosen] : [])
        : resolveSlotRef(state, execution, op.target);
      // 応答待ちにしたなら、まだ実行しない
      if (op.target.kind === 'choose' && !chosen) return;

      for (const { playerId, slotId } of targets) {
        const slot = state.players[playerId]?.pokemon.find((p) => p.slotId === slotId);
        if (!slot) continue;
        const delta = op.action === 'place' ? op.count : -op.count;
        slot.damageCounters = Math.max(0, slot.damageCounters + delta);
      }
      execution.cursor += 1;
      return;
    }

    /** 回復。amount はダメージ量なので、ダメカンに直すときに10で割る */
    case 'heal': {
      for (const { playerId, slotId } of resolveSlotRef(state, execution, op.target)) {
        const slot = state.players[playerId]?.pokemon.find((p) => p.slotId === slotId);
        if (!slot) continue;
        slot.damageCounters =
          op.amount === 'all' ? 0 : Math.max(0, slot.damageCounters - Math.round(op.amount / 10));
      }
      execution.cursor += 1;
      return;
    }

    /**
     * 効果をかける（T26）。
     * ★かかったあとは state.effects が持つ。失効は effects.ts の掃除が面倒を見る。
     */
    case 'applyEffect': {
      const effect = instantiateEffect(
        state,
        execution,
        op.effect,
        `${execution.executionId}-e${execution.cursor}`,
      );
      // 対象が決まらなければ何も起きない（ワザは宣言できる。T29）
      if (effect) state.effects.push(effect);
      execution.cursor += 1;
      return;
    }

    /**
     * ★他のカードのワザを使う（§5.1-3 / T43）。
     *
     * ★1つの仕組みで4種類を解決する。カードごとの実装をしない:
     *   ゾロアークGX（イカサマ）      … from: 'opponentActive'
     *   レジドラゴVSTAR（アポカリプス）… from: 'ownTrash' + filter でドラゴン
     *   メタモン（どこでもコピー）     … from: 'anyInPlay'
     *   ミュウツー&ミュウGX（パーフェクション）… from: 'ownTrash' 等
     *
     * ここでやるのは **参照を持たせるところまで**。
     * ダメージは人が6段パイプラインで確定させる（§4.1）ので、
     * 選んだカードのワザを `grantedAttacks` に積み、
     * あとは既存の「ワザを使う」メニューから普通に宣言してもらう。
     * ★どのワザを使うかの2段目の選択は、そのメニューがそのまま担う。
     */
    case 'useAttackAs': {
      const source = attackSourceSlot(state, execution);
      const candidates = attackCopyCandidates(state, execution, op, ctx);
      if (!source || candidates.length === 0) {
        execution.cursor += 1;
        return;
      }
      suspend(execution, {
        requestId: `${execution.executionId}-copy${execution.cursor}`,
        chooser: self,
        kind: 'selectCards',
        prompt: 'ワザをコピーするカードを1枚選んでください',
        candidates: candidates.map((entry) => entry.instanceId),
        min: 1,
        max: 1,
        // トラッシュは公開領域なので、追加で見せる必要はない
        temporarilyRevealed: [],
      });
      return;
    }

    /**
     * ★逃げ道（§7-5）。未自動化の効果はここで人間に投げる。
     *   これを含む効果は ASSISTED として扱う。
     */
    case 'manual': {
      suspend(execution, {
        requestId: `${execution.executionId}-m${execution.cursor}`,
        chooser: self,
        kind: 'confirm',
        prompt: op.prompt,
        candidates: [],
        min: 0,
        max: 0,
        temporarilyRevealed: [],
      });
      return;
    }

    /**
     * まだ自動化していないオペコード。
     * ★落とさずに人間へ投げる。T31 以降で1つずつ埋めていく。
     */
    default:
      break;
  }

  // 自動化していない場面。人間に投げる（ASSISTED の実体。§7-5）
  suspend(execution, {
    requestId: `${execution.executionId}-u${execution.cursor}`,
    chooser: self,
    kind: 'confirm',
    prompt: `「${op.op}」はまだ自動化されていません。手で処理してから進めてください`,
    candidates: [],
    min: 0,
    max: 0,
    temporarilyRevealed: [],
  });
}

/** cursor の直後に差し込む。cursor より前の位置は動かないので保存済みの位置がずれない */
function expandAt(execution: EffectExecution, ops: readonly Op[]): void {
  if (ops.length === 0) return;
  if (execution.ops.length + ops.length > MAX_EXPANDED_OPS) {
    throw new EffectError('効果の展開が大きすぎます');
  }
  execution.ops.splice(execution.cursor + 1, 0, ...ops);
}

function suspend(execution: EffectExecution, choice: ChoiceRequest): void {
  execution.pendingChoice = choice;
}

// ── 選択への応答（T25） ───────────────

/**
 * 応答待ちの選択に答える。state を直接書き換える版。
 *
 * ★ここで必ず一時公開を戻す（§3.3）。
 *   戻し忘れると、山札を1回見ただけで以後ずっと中身が見えたままになる。
 *   剥がすのは「この選択のために足した可視性」だけ。
 *   もともと見えていたカード（別の効果で公開中など）はそのまま残す。
 */
// ── ★ワザのコピー（§5.1-3 / T43） ─────────

/** コピーを使う側のスロット。効果の発生源が場にいるところ */
function attackSourceSlot(
  state: GameState,
  execution: EffectExecution,
): { playerId: PlayerId; slotId: SlotId } | undefined {
  const instanceId = execution.source.instanceId;
  if (!instanceId) return undefined;
  for (const [playerId, player] of Object.entries(state.players)) {
    const slot = player.pokemon.find((entry) => entry.stack.includes(instanceId));
    if (slot) return { playerId, slotId: slot.slotId };
  }
  return undefined;
}

/**
 * コピー元になりうるカード。
 * ★`from` の3種類をここだけで分ける。カードごとの分岐は作らない。
 */
export function attackCopyCandidates(
  state: GameState,
  execution: EffectExecution,
  op: Extract<Op, { op: 'useAttackAs' }>,
  ctx: RuleContext,
): { instanceId: string; card: CardText }[] {
  const self = execution.source.playerId;
  const opponent = resolveSinglePlayer(state, self, 'opponent');

  const pickCard = (instanceId: string | undefined): { instanceId: string; card: CardText } | null => {
    if (!instanceId) return null;
    const instance = state.cards[instanceId];
    if (!instance || instance.functionalId === '') return null;
    const card = ctx.cards?.byFunctionalId.get(instance.functionalId);
    // ★ワザを持たないカードは候補にしない。正体が見えないカードも選ばせない
    if (!card || card.supertype !== 'pokemon' || (card.attacks?.length ?? 0) === 0) return null;
    if (!matchesCardFilter(card, op.filter)) return null;
    return { instanceId, card };
  };

  const out: { instanceId: string; card: CardText }[] = [];
  const push = (entry: { instanceId: string; card: CardText } | null): void => {
    if (entry) out.push(entry);
  };

  switch (op.from) {
    case 'opponentActive': {
      const slot = opponent
        ? state.players[opponent]?.pokemon.find((entry) => entry.slotId === 'active')
        : undefined;
      push(pickCard(slot?.stack[slot.stack.length - 1]));
      break;
    }
    case 'ownTrash':
      for (const instance of Object.values(state.cards)) {
        if (instance.ownerId === self && instance.zone === 'discard') push(pickCard(instance.instanceId));
      }
      break;
    /** ★自分のベンチ（ミュウVMAX のクロスフュージョン。T44） */
    case 'ownBench':
      for (const slot of state.players[self]?.pokemon ?? []) {
        if (slot.slotId !== 'active') push(pickCard(slot.stack[slot.stack.length - 1]));
      }
      break;
    case 'anyInPlay':
      for (const player of Object.values(state.players)) {
        for (const slot of player.pokemon) push(pickCard(slot.stack[slot.stack.length - 1]));
      }
      break;
  }
  return out;
}

export function resolveChoiceInPlace(
  state: GameState,
  requestId: string,
  selected: readonly string[],
  rolls: EffectRolls,
  ctx: RuleContext,
): void {
  const execution = state.execution;
  const choice = execution?.pendingChoice;
  if (!execution || !choice) return;
  // 古い応答の取りこぼしは黙って捨てる
  if (choice.requestId !== requestId) return;

  const picked = selected.filter((id) => choice.candidates.includes(id));

  // 1. 一時公開を戻す（移動より先に。移動先の可視性を上書きしないため）
  restoreTemporaryReveal(state);

  // 2. いま止まっているオペコードの後始末
  const op = execution.ops[execution.cursor];
  if (
    (op?.op === 'attachEnergy' || op?.op === 'evolve' || op?.op === 'damageCounter') &&
    choice.kind === 'selectSlot'
  ) {
    const selectedId = picked[0];
    for (const [playerId, player] of Object.entries(state.players)) {
      const slot = player.pokemon.find((entry) => entry.stack.at(-1) === selectedId);
      if (slot) execution.bindings[targetBinding(execution)] = [{ playerId, slotId: slot.slotId }];
    }
    execution.pendingChoice = null;
    return;
  }

  if (op?.op === 'switch' && choice.kind === 'selectSlot') {
    const selectedId = picked[0];
    const playerId = op.side === 'own'
      ? execution.source.playerId
      : resolveSinglePlayer(state, execution.source.playerId, 'opponent');
    const player = playerId ? state.players[playerId] : undefined;
    const active = player?.pokemon.find((slot) => slot.slotId === 'active');
    const bench = player?.pokemon.find((slot) => slot.stack.at(-1) === selectedId);
    if (active && bench) {
      const oldBenchId = bench.slotId;
      active.slotId = oldBenchId;
      bench.slotId = 'active';
      syncSlotZones(state, active);
      syncSlotZones(state, bench);
    }
    execution.pendingChoice = null;
    execution.cursor += 1;
    if (execution.cursor >= execution.ops.length) state.execution = null;
    return;
  }

  if (op?.op === 'chooseOption') {
    execution.bindings[op.bind] = picked[0] ?? '';
  }

  /*
   * ★コピーしたワザを、使う側のポケモンに持たせる（T43）。
   *   ここでは **参照を積むだけ**。実際の宣言とダメージは人が行う。
   *   前に積んだ参照は入れ替える（前の番のコピーが残らないように）。
   */
  if (op?.op === 'useAttackAs') {
    const source = attackSourceSlot(state, execution);
    const instanceId = picked[0];
    const instance = instanceId ? state.cards[instanceId] : undefined;
    const card = instance ? ctx.cards?.byFunctionalId.get(instance.functionalId) : undefined;
    const slot = source
      ? state.players[source.playerId]?.pokemon.find((entry) => entry.slotId === source.slotId)
      : undefined;
    if (slot && instanceId && card) {
      slot.grantedAttacks = (card.attacks ?? []).map((_, attackIndex) => ({
        functionalId: card.functionalId,
        attackIndex,
        sourceInstanceId: instanceId,
      }));
    }
  }

  if (op?.op === 'search') {
    for (const instanceId of picked) {
      if (op.dest === 'bench') placeOnBench(state, instanceId, execution.source.playerId, ctx);
      else relocate(state, instanceId, op.dest);
      const card = state.cards[instanceId];
      // 「相手に見せて」加えるなら、相手にも見えたままにする（あとで手で伏せられる）
      if (card && op.dest === 'hand') {
        card.visibleTo = op.reveal ? Object.keys(state.players) : [card.ownerId];
      }
    }
    if (op.bind) execution.bindings[op.bind] = [...picked];
    if (op.thenShuffle && rolls.order) applyShuffleOrder(state, rolls.order);
  } else if (op?.op === 'discard') {
    for (const instanceId of picked) relocate(state, instanceId, 'discard');
    if (op.bind) execution.bindings[op.bind] = [...picked];
  } else if (op?.op === 'moveCard') {
    movePicked(state, picked, op.to, op.position, op.includeAttached);
    if (op.bind) execution.bindings[op.bind] = [...picked];
  } else if (op?.op === 'attachEnergy') {
    const target = boundTarget(state, execution, op.target);
    const slot = target
      ? state.players[target.playerId]?.pokemon.find((entry) => entry.slotId === target.slotId)
      : undefined;
    if (slot) {
      for (const instanceId of picked) {
        relocate(state, instanceId, slot.slotId === 'active' ? 'active' : 'bench');
        slot.attachedEnergy.push(instanceId);
      }
      syncSlotZones(state, slot);
    }
    if (op.thenShuffle && rolls.order) applyShuffleOrder(state, rolls.order);
  } else if (op?.op === 'evolve') {
    const target = boundTarget(state, execution, op.target);
    const slot = target
      ? state.players[target.playerId]?.pokemon.find((entry) => entry.slotId === target.slotId)
      : undefined;
    const instanceId = picked[0];
    if (slot && instanceId) {
      relocate(state, instanceId, slot.slotId === 'active' ? 'active' : 'bench');
      slot.stack.push(instanceId);
      slot.evolvedOnTurn = state.turn;
      syncSlotZones(state, slot);
    }
    if (op.thenShuffle && rolls.order) applyShuffleOrder(state, rolls.order);
  }

  execution.pendingChoice = null;
  execution.cursor += 1;

  if (execution.cursor >= execution.ops.length) state.execution = null;
  // ctx は今後のオペコードで使う。ここでは参照しない
  void ctx;
}

/**
 * 一時公開を剥がす。
 *
 * ★答えたときだけでなく、**打ち切ったときにも必ず呼ぶこと**。
 *   呼び忘れると「サーチを開いてキャンセルすれば山札が見放題」になる。
 *
 * 剥がすのは temporarilyRevealed に記録された「この選択のために足したぶん」だけ。
 * もともと見えていたカードはそのまま残る。
 */
export function restoreTemporaryReveal(state: GameState): void {
  const choice = state.execution?.pendingChoice;
  if (!choice) return;
  for (const instanceId of choice.temporarilyRevealed) {
    const card = state.cards[instanceId];
    if (card) card.visibleTo = card.visibleTo.filter((id) => id !== choice.chooser);
  }
}

/** サーバーが決めた並びをそのまま反映する（§4.2） */
function applyShuffleOrder(state: GameState, order: readonly string[]): void {
  order.forEach((instanceId, i) => {
    const card = state.cards[instanceId];
    if (!card) return;
    card.position = i;
    if (card.zone === 'hand') {
      card.visibleTo = [card.ownerId];
      card.faceUp = false;
    } else {
      card.visibleTo = [];
      card.faceUp = false;
    }
  });
}

// ── 小道具 ──────────────────────────

/** カードの正体。見えない・定義がなければ undefined */
function cardTextOf(card: CardInstance, index: CardIndex | null | undefined): CardText | undefined {
  if (card.functionalId === '') return undefined;
  return index?.byFunctionalId.get(card.functionalId);
}

function eligibleZoneCards(
  state: GameState,
  owner: PlayerId,
  zone: Zone | 'inPlay' | 'field',
): CardInstance[] {
  if (zone === 'field') {
    const stadium = state.stadium && state.cards[state.stadium]?.ownerId === owner
      ? [state.cards[state.stadium]!]
      : [];
    const attached = (state.players[owner]?.pokemon ?? []).flatMap((slot) => [
        ...slot.attachedEnergy.flatMap((id) => (state.cards[id] ? [state.cards[id]!] : [])),
        ...(slot.attachedTool && state.cards[slot.attachedTool] ? [state.cards[slot.attachedTool]!] : []),
      ]);
    return [...stadium, ...attached];
  }
  if (zone === 'inPlay') {
    return (state.players[owner]?.pokemon ?? []).flatMap((slot) => {
      const top = slot.stack.at(-1);
      return top && state.cards[top] ? [state.cards[top]!] : [];
    });
  }
  const cards = cardsInZoneOf(state, owner, zone);
  if (zone !== 'active' && zone !== 'bench') return cards;
  const topIds = new Set(
    (state.players[owner]?.pokemon ?? []).flatMap((slot) => {
      const top = slot.stack.at(-1);
      return top ? [top] : [];
    }),
  );
  return cards.filter((card) => topIds.has(card.instanceId));
}

function placeOnBench(state: GameState, instanceId: string, playerId: PlayerId, ctx: RuleContext): void {
  const player = state.players[playerId];
  if (!player) return;
  const occupied = new Set(player.pokemon.map((slot) => slot.slotId));
  const limit = getBenchLimit(state, playerId, ctx);
  let slotId: SlotId | undefined;
  for (let i = 0; i < limit; i += 1) {
    const candidate = `bench-${i}` as SlotId;
    if (!occupied.has(candidate)) {
      slotId = candidate;
      break;
    }
  }
  if (!slotId) return;
  relocate(state, instanceId, 'bench');
  player.pokemon.push({
    slotId,
    stack: [instanceId],
    attachedEnergy: [],
    attachedTool: null,
    damageCounters: 0,
    conditions: [],
    placedOnTurn: state.turn,
    evolvedOnTurn: null,
    devolvedOnTurn: null,
    grantedAttacks: [],
    notes: '',
  });
}

function movePicked(
  state: GameState,
  picked: readonly string[],
  to: Zone,
  position: 'top' | 'bottom' = 'bottom',
  includeAttached = false,
): void {
  for (const instanceId of picked) {
    const slot = Object.values(state.players)
      .flatMap((player) => player.pokemon)
      .find((entry) => entry.stack.at(-1) === instanceId);
    const ids = includeAttached && slot
      ? [...slot.stack, ...slot.attachedEnergy, ...(slot.attachedTool ? [slot.attachedTool] : [])]
      : [instanceId];
    for (const id of ids) relocate(state, id, to, position);
  }
}
