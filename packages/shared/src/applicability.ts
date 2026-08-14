/**
 * 「状況が変化しないなら使えない」判定（第3段階 §? / T29）。
 *
 * 公式ルールでは、ワザとトレーナーズで挙動が違う:
 *
 *   | 条件を満たせない場合 |
 *   |---|
 *   | ワザ                          | **宣言できる。** 従える部分だけ従う |
 *   | グッズ / サポート / スタジアム / 特性 | **そもそも使えない** |
 *
 * 例:
 *   - ベンチが満杯でも「山札からたねポケモンをベンチに出す」ワザは宣言できる。
 *     山札を見ずにそこで終わる（見られると情報が漏れるので、見せてもいけない）。
 *   - ダメカンがのっているポケモンが1匹もいないなら、回復のグッズは **使えない**。
 *
 * ★判定は dry-run で行う。
 *   オペコードごとに「本当にやってみたら盤面が変わるか」を複製した状態の上で試す。
 *   条件を op ごとに手で書き下すと、カードを実装するたびに判定側も直すことになる。
 *
 * ★ただし **禁止はしない**（第2段階 §2 の絶対原則）。
 *   ここが返すのは判断材料だけ。実際の操作は rules.ts が警告を出したうえで必ず通す。
 *   ジバコイルやふしぎなアメのような例外カードを殺さないため。
 */
import { matchesCardFilter } from './cardFilter';
import type { CardIndex } from './cards';
import type { EffectSource, Op, OpCode, SlotRef } from './dsl';
import {
  createExecution,
  MAX_EXPANDED_OPS,
  restoreTemporaryReveal,
  slotCandidates,
  stepEffectInPlace,
} from './interpreter';
import type { RuleContext } from './rules';
import type { GameState, PlayerId, SlotId, TrainerKind } from './types';

// ── 結果の型 ──────────────────────────

/**
 * - `changes`  … 盤面が変わる
 * - `noChange` … 何も起きない
 * - `unknown`  … 判定できない（manual・未自動化のオペコード）
 */
export type OpApplicability = 'changes' | 'noChange' | 'unknown';

export interface DryRunOpOutcome {
  /** 展開後のオペコード列での位置 */
  index: number;
  op: OpCode;
  outcome: OpApplicability;
}

export interface DryRunResult {
  /** 盤面を動かすオペコードが1つでもあるか */
  changes: boolean;
  /** 判定できなかったオペコードがあるか */
  uncertain: boolean;
  /** オペコードごとの内訳。UI で「どこが効くか」を出すために持つ */
  ops: DryRunOpOutcome[];
}

/** ワザ・特性・トレーナーズの別。判定が変わるのはこの区別だけ */
export type EffectUseKind = 'attack' | 'ability' | TrainerKind;

export interface UsabilityVerdict {
  kind: EffectUseKind;
  /** 使えるか。ワザは常に true（宣言できる） */
  usable: boolean;
  /** 一部のオペコードだけ従える状態か */
  partial: boolean;
  /** 画面とログにそのまま出す日本語。問題なければ null */
  reason: string | null;
  dryRun: DryRunResult;
}

// ── 入口 ─────────────────────────────

/**
 * §T29 の `canApply(state, ops)`。
 * 「使ったら状況が変わるか」だけを返す。
 *
 * ★判定できないオペコード（manual・未自動化）は **使える** 側に倒す。
 *   「何も起きないと証明できた」ときだけ false にする。
 */
export function canApply(
  state: GameState,
  ops: readonly Op[],
  source: EffectSource = defaultSource(state),
  ctx: RuleContext = {},
): boolean {
  const result = dryRunOps(state, ops, source, ctx);
  return result.changes || result.uncertain;
}

function defaultSource(state: GameState): EffectSource {
  return {
    instanceId: null,
    playerId: state.activePlayer || Object.keys(state.players)[0] || '',
    label: '効果',
  };
}

/**
 * ワザ / 特性 / トレーナーズの違いを込みで判定する。
 * ★ワザは条件を満たせなくても宣言できる。ここが T29 の肝。
 */
export function checkUsability(
  state: GameState,
  kind: EffectUseKind,
  ops: readonly Op[],
  source: EffectSource,
  ctx: RuleContext = {},
): UsabilityVerdict {
  const dryRun = dryRunOps(state, ops, source, ctx);
  const effective = dryRun.changes || dryRun.uncertain;
  const skipped = dryRun.ops.filter((o) => o.outcome === 'noChange').length;
  const partial = effective && skipped > 0;

  if (kind === 'attack') {
    // ★ワザは必ず宣言できる。従える部分だけ従う
    const reason = !effective
      ? '効果は何も起きませんが、ワザは宣言できます'
      : partial
        ? `従える部分だけ従います（${skipped}個の処理は何も起きません）`
        : null;
    return { kind, usable: true, partial, reason, dryRun };
  }

  if (!effective) {
    return {
      kind,
      usable: false,
      partial: false,
      reason: `${USE_KIND_LABEL[kind]}を使っても状況が変わらないので、使えません`,
      dryRun,
    };
  }
  return {
    kind,
    usable: true,
    partial,
    reason: partial ? `${skipped}個の処理は何も起きません` : null,
    dryRun,
  };
}

export const USE_KIND_LABEL: Record<EffectUseKind, string> = {
  attack: 'ワザ',
  ability: '特性',
  item: 'グッズ',
  tool: 'ポケモンのどうぐ',
  supporter: 'サポート',
  stadium: 'スタジアム',
};

/**
 * 効果の発生源から「ワザか / 特性か / どのトレーナーズか」を割り出す。
 * 分からなければ null（判定しない）。
 */
export function useKindOf(
  state: GameState,
  ctx: RuleContext,
  source: EffectSource,
): EffectUseKind | null {
  if (source.attackIndex !== undefined) return 'attack';
  if (source.abilityIndex !== undefined) return 'ability';
  const card = cardTextOfInstance(state, ctx.cards, source.instanceId);
  if (card?.supertype === 'trainer') return card.trainerKind ?? null;
  return null;
}

// ── dry-run 本体 ───────────────────────

/** dry-run で choose を差し替えるときに使う束縛名。実行には出てこない */
const DRY_BINDING = '__dryRunSlot';

export function dryRunOps(
  state: GameState,
  ops: readonly Op[],
  source: EffectSource,
  ctx: RuleContext = {},
): DryRunResult {
  const outcomes: DryRunOpOutcome[] = [];

  let work: GameState;
  try {
    work = structuredClone(state);
    work.execution = createExecution({ executionId: DRY_RUN_ID, ops, source });
  } catch {
    // 展開が大きすぎる等。判定できないので「使える」側に倒す
    return { changes: false, uncertain: true, ops: outcomes };
  }

  for (let guard = 0; guard < MAX_EXPANDED_OPS; guard += 1) {
    const execution = work.execution;
    if (!execution) break;
    const index = execution.cursor;
    const op = execution.ops[index];
    if (op === undefined) break;

    // 1. 制御構造はそのまま動かす（盤面は変えず、枝を展開するだけ）
    if (op.op === 'if' || op.op === 'repeat') {
      work = advanceOnce(work, ctx).state;
      continue;
    }

    // 2. ★シャッフルだけでは「状況が変わった」と数えない。
    //    山札を切るのは他の処理の後始末なので、これを変化に数えると
    //    「山札を切るだけのグッズはいつでも使える」ことになってしまう。
    if (op.op === 'shuffle') {
      outcomes.push({ index, op: op.op, outcome: 'noChange' });
      work = skipCurrentOp(work);
      continue;
    }

    // 3. choose を含むオペコードは、候補スロットを1つずつ当てはめて試す
    const chooseRefs = collectChooseRefs(op);
    if (chooseRefs.length > 0) {
      const step = tryChooseOp(work, op, chooseRefs, ctx);
      outcomes.push({ index, op: op.op, outcome: step.outcome });
      work = step.state;
      continue;
    }

    // 4. それ以外は実際に動かして、盤面が変わったかどうかで判定する
    const step = advanceOnce(work, ctx);
    outcomes.push({ index, op: op.op, outcome: step.outcome });
    work = step.state;
  }

  return {
    changes: outcomes.some((o) => o.outcome === 'changes'),
    uncertain: outcomes.some((o) => o.outcome === 'unknown'),
    ops: outcomes,
  };
}

const DRY_RUN_ID = 'dry-run';

/**
 * オペコードを1つだけ実際に動かして、盤面が変わったかを見る。
 *
 * 応答待ちになった場合:
 *   - 選ぶものがある（候補あり・1枚以上選べる）→ 変わる
 *   - 確認だけ（manual・未自動化）           → 判定できない
 * どちらも予行なので、その場で選択を畳んで次のオペコードへ進める。
 */
function advanceOnce(
  state: GameState,
  ctx: RuleContext,
): { state: GameState; outcome: OpApplicability } {
  const before = fingerprint(state);
  const next = structuredClone(state);
  try {
    // 乱数は渡さない。乱数が要るオペコードは 2. で先に除いてある
    stepEffectInPlace(next, {}, ctx);
  } catch {
    // ここまで来られない＝判定できない
    return { state: skipCurrentOp(state), outcome: 'unknown' };
  }

  const choice = next.execution?.pendingChoice ?? null;
  if (choice) {
    const outcome: OpApplicability =
      choice.kind === 'confirm'
        ? 'unknown'
        : choice.candidates.length > 0 && choice.max > 0
          ? 'changes'
          : 'noChange';
    // ★予行でも一時公開は必ず戻す（§3.3）。複製の上とはいえ、剥がし忘れを癖にしない
    restoreTemporaryReveal(next);
    if (next.execution) {
      next.execution.pendingChoice = null;
      next.execution.cursor += 1;
      if (next.execution.cursor >= next.execution.ops.length) next.execution = null;
    }
    return { state: next, outcome };
  }

  return { state: next, outcome: fingerprint(next) === before ? 'noChange' : 'changes' };
}

/**
 * choose を含むオペコードの予行。
 *
 * 「選ぶ」は人が決めることなので、候補を1つずつ当てはめて
 * **どれか1つでも盤面が変われば「変わる」** とする。
 * 変わるものが見つかったら、その候補を選んだことにして先へ進める。
 */
function tryChooseOp(
  state: GameState,
  op: Op,
  chooseRefs: readonly SlotRef[],
  ctx: RuleContext,
): { state: GameState; outcome: OpApplicability } {
  const execution = state.execution;
  const ref = chooseRefs[0];
  // 1つのオペコードで2か所選ばせるもの（ダメカンの移動など）は判定しない
  if (!execution || !ref || chooseRefs.length > 1) {
    return { state: skipCurrentOp(state), outcome: 'unknown' };
  }

  const candidates = slotCandidates(state, execution, ref, ctx);
  if (candidates.length === 0) {
    // ★選べるポケモンが1匹もいない。回復カードが使えないのはここ
    return { state: skipCurrentOp(state), outcome: 'noChange' };
  }

  const rewritten = replaceChooseRefs(op, DRY_BINDING) as Op;
  for (const candidate of candidates) {
    const probe = structuredClone(state);
    const probeExecution = probe.execution;
    if (!probeExecution) break;
    probeExecution.ops[probeExecution.cursor] = rewritten;
    probeExecution.bindings[DRY_BINDING] = [candidate];

    const step = advanceOnce(probe, ctx);
    if (step.outcome !== 'noChange') {
      // その候補を選んだものとして先へ進める（後続のオペコードが見る盤面を作る）
      delete step.state.execution?.bindings[DRY_BINDING];
      return step;
    }
  }
  return { state: skipCurrentOp(state), outcome: 'noChange' };
}

/** 盤面を動かさずにオペコードを1つ飛ばす */
function skipCurrentOp(state: GameState): GameState {
  const next = structuredClone(state);
  if (!next.execution) return next;
  next.execution.cursor += 1;
  if (next.execution.cursor >= next.execution.ops.length) next.execution = null;
  return next;
}

/**
 * 「状況が変わったか」を見るための指紋。
 *
 * ★可視性（visibleTo / faceUp）は入れない。
 *   山札を覗いただけでは状況は変わらないし、
 *   一時公開の戻し忘れを「変化」と読み違えたくない。
 */
function fingerprint(state: GameState): string {
  return JSON.stringify({
    players: Object.entries(state.players)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([id, player]) => [
        id,
        player.pokemon,
        player.prizesRemaining,
        player.benchLimit,
        player.turnFlags,
      ]),
    cards: Object.values(state.cards)
      .map((card) => [card.instanceId, card.zone, card.position ?? null])
      .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
    effects: state.effects,
    stadium: state.stadium,
  });
}

// ── choose 参照の抜き差し ─────────────────

/**
 * オペコードの中の choose な SlotRef を集める。
 * オペコードは素のデータなので、構造をたどるだけで見つかる。
 */
function collectChooseRefs(value: unknown, out: SlotRef[] = []): SlotRef[] {
  if (Array.isArray(value)) {
    for (const item of value) collectChooseRefs(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    if (isChooseRef(value)) {
      out.push(value as SlotRef);
      return out;
    }
    for (const item of Object.values(value)) collectChooseRefs(item, out);
  }
  return out;
}

/** choose な SlotRef を binding 参照に差し替える（値は変えない） */
function replaceChooseRefs(value: unknown, name: string): unknown {
  if (Array.isArray(value)) return value.map((item) => replaceChooseRefs(item, name));
  if (value && typeof value === 'object') {
    if (isChooseRef(value)) return { kind: 'binding', name };
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceChooseRefs(item, name)]),
    );
  }
  return value;
}

function isChooseRef(value: object): boolean {
  const obj = value as Record<string, unknown>;
  return obj.kind === 'choose' && 'player' in obj && 'chooser' in obj;
}

// ── 小道具 ───────────────────────────

function cardTextOfInstance(
  state: GameState,
  index: CardIndex | null | undefined,
  instanceId: string | null,
) {
  if (!instanceId) return undefined;
  const instance = state.cards[instanceId];
  if (!instance || instance.functionalId === '') return undefined;
  return index?.byFunctionalId.get(instance.functionalId);
}

/**
 * 「山札からベンチに出す」系が、ベンチ満杯で止まるかどうか。
 * ★止まるときは **山札を見せない**（見せると中身が漏れる）。
 *   インタプリタの search はここを見て、候補を作る前に打ち切る。
 */
export function benchHasRoom(
  state: GameState,
  playerId: PlayerId,
  benchLimit: number,
): boolean {
  const bench = (state.players[playerId]?.pokemon ?? []).filter(
    (slot: { slotId: SlotId }) => slot.slotId !== 'active',
  );
  return bench.length < benchLimit;
}

/** カード条件に合うカードが、そのゾーンに1枚でもあるか（判定の下ごしらえ） */
export function zoneHasMatch(
  state: GameState,
  ctx: RuleContext,
  owner: PlayerId,
  zone: string,
  filter: Parameters<typeof matchesCardFilter>[1] | undefined,
): boolean {
  return Object.values(state.cards).some(
    (card) =>
      card.ownerId === owner &&
      card.zone === zone &&
      (filter === undefined ||
        matchesCardFilter(cardTextOfInstance(state, ctx.cards, card.instanceId), filter)),
  );
}
