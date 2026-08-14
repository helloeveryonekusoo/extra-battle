/**
 * きぜつの検出（T16）。
 *
 * ★ここも「検出するだけ」。自動でトラッシュへ送ったりサイドをとったりはしない。
 *   残りHPが0になったことに気づかせて、確認ダイアログを出すための材料を作る。
 *
 * ★サイドの枚数は ruleBox から **既定値** を出すだけで、確定値ではない。
 *   オルタージェネシスGX で+1、げっこうしゅりけんで複数まとめて、といった例外が実在するので、
 *   最後は必ず人が枚数を決められること。
 */
import { ruleFor } from './ruleBox';
import type { RuleContext } from './rules';
import type { CardText, GameState, PlayerId, PokemonInPlay, RuleBox, SlotId } from './types';

/** ダメカン1個ぶんのダメージ */
export const DAMAGE_PER_COUNTER = 10;

/**
 * きぜつさせた側がとるサイドの既定枚数。
 * ★あくまで既定値。UI で必ず変更できるようにすること。
 *   BREAK・プリズムスター・かがやくポケモンは 1枚（ルールを持つが枚数は増えない）。
 */
export function prizesForRuleBox(ruleBox: RuleBox | undefined): number {
  // ★枚数の出どころは ruleBox.ts の表ひとつだけ（T36）
  return ruleFor(ruleBox).prizes;
}

/** 検出のタイミング（3つ）。ダイアログの見出しに使う */
export type KnockoutTiming = 'afterAttack' | 'pokemonCheck' | 'other';

export const KNOCKOUT_TIMING_LABEL: Record<KnockoutTiming, string> = {
  afterAttack: 'ワザの処理の最後',
  pokemonCheck: 'ポケモンチェックの最後',
  other: '残りHPが0になりました',
};

export interface KnockoutCandidate {
  /** 同じポケモンを指す安定したキー。進化・入れ替えで変わる */
  key: string;
  playerId: PlayerId;
  slotId: SlotId;
  /** 進化スタックの一番上 */
  topInstanceId: string | undefined;
  /** 指示書の KnockoutCandidate.pokemonName */
  pokemonName: string;
  ruleBox: RuleBox | undefined;
  /** 現在の進化先が持つ最大HP（指示書の currentHp） */
  currentHp: number;
  damageCounters: number;
  /** のっているダメージ量（指示書の damage） */
  damage: number;
  /** 0 以下ならきぜつ */
  remainingHp: number;
  /** ★ruleBox から算出した既定値。手で変更できること */
  suggestedPrizeCount: number;
  /** サイドをとる側。2人卓なら持ち主の相手 */
  prizeTo: PlayerId | null;
  /** トラッシュへ送るカードの枚数（進化スタック + エネルギー + どうぐ） */
  attachedCount: number;
  stackSize: number;
}

/** 進化スタックの一番上のカード定義。見えない・定義がなければ undefined */
export function topCardOf(
  state: GameState,
  ctx: RuleContext,
  slot: PokemonInPlay,
): CardText | undefined {
  const topId = slot.stack[slot.stack.length - 1];
  if (!topId) return undefined;
  const instance = state.cards[topId];
  if (!instance || instance.functionalId === '') return undefined;
  return ctx.cards?.byFunctionalId.get(instance.functionalId);
}

/** 残りHP。HPが分からない（カード定義がない・見えない）なら null */
export function remainingHpOf(
  state: GameState,
  ctx: RuleContext,
  slot: PokemonInPlay,
): number | null {
  const hp = topCardOf(state, ctx, slot)?.hp;
  if (hp === undefined) return null;
  return hp - slot.damageCounters * DAMAGE_PER_COUNTER;
}

/**
 * そのポケモンがきぜつしているか。
 * ★HPが分からないときは false。勝手に「きぜつだ」と言わない。
 */
export function isKnockedOut(state: GameState, ctx: RuleContext, slot: PokemonInPlay): boolean {
  const remaining = remainingHpOf(state, ctx, slot);
  return remaining !== null && remaining <= 0;
}

function candidateOf(
  state: GameState,
  ctx: RuleContext,
  playerId: PlayerId,
  slot: PokemonInPlay,
): KnockoutCandidate | null {
  const card = topCardOf(state, ctx, slot);
  if (card?.hp === undefined) return null;
  const remainingHp = card.hp - slot.damageCounters * DAMAGE_PER_COUNTER;
  if (remainingHp > 0) return null;

  const topInstanceId = slot.stack[slot.stack.length - 1];
  const opponent = Object.keys(state.players).find((id) => id !== playerId) ?? null;

  return {
    key: `${playerId}/${slot.slotId}/${topInstanceId ?? '-'}`,
    playerId,
    slotId: slot.slotId,
    topInstanceId,
    pokemonName: card.name,
    ruleBox: card.ruleBox,
    currentHp: card.hp,
    damageCounters: slot.damageCounters,
    damage: slot.damageCounters * DAMAGE_PER_COUNTER,
    remainingHp,
    suggestedPrizeCount: prizesForRuleBox(card.ruleBox),
    prizeTo: opponent,
    attachedCount: slot.attachedEnergy.length + (slot.attachedTool ? 1 : 0),
    stackSize: slot.stack.length,
  };
}

/**
 * 盤面全体からきぜつしているポケモンを拾う。
 * ★どのタイミングで呼んでもよい。状態から毎回作り直すので、
 *   「ワザの最後」「ポケモンチェックの最後」「それ以外」の3つとも同じ関数で拾える。
 */
export function findKnockoutCandidates(
  state: GameState,
  ctx: RuleContext,
): KnockoutCandidate[] {
  const out: KnockoutCandidate[] = [];
  for (const [playerId, player] of Object.entries(state.players)) {
    for (const slot of player.pokemon) {
      const candidate = candidateOf(state, ctx, playerId, slot);
      if (candidate) out.push(candidate);
    }
  }
  return out;
}

/**
 * 直近の操作から、いまがどの検出タイミングかを見る。
 * ワザ宣言のあとダメカンを乗せている間は「ワザの処理の最後」として扱う。
 */
export function knockoutTimingOf(state: GameState): KnockoutTiming {
  if (state.phase === 'pokemonCheck') return 'pokemonCheck';
  for (let i = state.log.length - 1; i >= 0; i -= 1) {
    const entry = state.log[i];
    if (!entry || entry.undone) continue;
    if (entry.action.type === 'useAttack') return 'afterAttack';
    // ダメージを乗せる操作はワザ処理の一部でありうるので、さかのぼりを続ける
    if (entry.action.type === 'adjustDamage' || entry.action.type === 'setDamage') continue;
    // ポケモンチェック完了直後は endTurn に続けて開始ドローが記録される。
    // ダイアログはチェック中には重ねず、この状態更新後に出すため、直前のフェーズを復元する。
    if (entry.action.type === 'drawCards') continue;
    if (entry.action.type === 'endTurn') {
      for (let j = i - 1; j >= 0; j -= 1) {
        const before = state.log[j];
        if (!before || before.undone) continue;
        if (before.action.type === 'setPhase') {
          return before.action.phase === 'pokemonCheck' ? 'pokemonCheck' : 'other';
        }
        if (before.action.type === 'endTurn') break;
      }
      return 'other';
    }
    return 'other';
  }
  return 'other';
}
