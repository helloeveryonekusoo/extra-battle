/**
 * かかっている効果の保持と失効（第3段階 §3.2 / T26）。
 *
 * ★ここに入れてよいのは「一度かかったら、あとから条件が変わっても残る効果」だけ。
 *   特性ロック（ダストオキシン等）やスタジアムの常時効果は **ここに書かない**（§2.2）。
 *   ロックは解除されうるので、状態に書き込むと巻き戻しが正しく動かない。
 *   そういうものは T27 の派生状態レイヤで「参照するたびに計算」する。
 *
 * ★消滅ルールは公式の明文（上級プレイヤー用ルールガイド）。必ず守る:
 *     ベンチに戻る / 入れ替わる      → 特殊状態・かかっている効果すべて
 *     場を離れる                     → すべて
 *     進化する / 退化する            → 特殊状態・かかっている効果すべて
 *                                      （エネルギー・どうぐ・ダメカンは引きつぐ）
 *   スロットにかかっている効果は、この4つでは **expiresOn の指定によらず必ず消える**。
 *   expiresOn はそこに条件を足すためのもの（sourceLeavesPlay など）。
 */
import { matchesCardFilter } from './cardFilter';
import type {
  ActiveEffect,
  ActiveEffectTemplate,
  CardFilter,
  EffectApplyAt,
  EffectExecution,
  EffectTarget,
} from './dsl';
import { resolvePlayerRef, resolveSlotRef } from './interpreter';
import type { CardText, GameState, PlayerId, SlotId } from './types';

/**
 * 効果のかかり先を表す文字列。`p-1/active` の形。
 * ★ActiveEffect.target.slotId は「プレイヤーとスロットの組」を1つの文字列で持つ。
 *   スロットIDだけでは、どちらのプレイヤーの場かが分からないため。
 */
export const effectSlotKey = (playerId: PlayerId, slotId: SlotId): string =>
  `${playerId}/${slotId}`;

export function parseEffectSlotKey(
  key: string,
): { playerId: PlayerId; slotId: SlotId } | null {
  const at = key.indexOf('/');
  if (at <= 0) return null;
  return { playerId: key.slice(0, at), slotId: key.slice(at + 1) as SlotId };
}

const isSlotTarget = (target: EffectTarget): target is { slotId: string } =>
  'slotId' in target;

/** 場に出ているか（スタジアムを含む） */
function isInPlay(state: GameState, instanceId: string | null): boolean {
  if (!instanceId) return false;
  const zone = state.cards[instanceId]?.zone;
  return zone === 'active' || zone === 'bench' || zone === 'stadium';
}

function slotExists(state: GameState, key: string): boolean {
  const parsed = parseEffectSlotKey(key);
  if (!parsed) return false;
  return Boolean(
    state.players[parsed.playerId]?.pokemon.some((p) => p.slotId === parsed.slotId),
  );
}

// ── 付与 ────────────────────────────

/**
 * applyEffect オペコードのひな型を、実際にかかる効果へ変える。
 * 対象が決まらなければ null（何も起きない）。
 */
export function instantiateEffect(
  state: GameState,
  execution: EffectExecution,
  template: ActiveEffectTemplate,
  effectId: string,
): ActiveEffect | null {
  const self = execution.source.playerId;

  let target: EffectTarget | null = null;
  if ('global' in template.target) {
    target = { global: true };
  } else if ('player' in template.target) {
    const playerId = resolvePlayerRef(state, self, template.target.player)[0];
    target = playerId ? { player: playerId } : null;
  } else {
    const slot = resolveSlotRef(state, execution, template.target.slot)[0];
    target = slot ? { slotId: effectSlotKey(slot.playerId, slot.slotId) } : null;
  }
  if (!target) return null;

  return {
    effectId,
    source: { ...execution.source },
    target,
    applyAt: template.applyAt,
    kind: template.kind,
    payload: { ...(template.payload ?? {}), ...(template.label ? { label: template.label } : {}) },
    duration: { ...template.duration },
    expiresOn: [...(template.expiresOn ?? [])],
    createdOnTurn: state.turn,
  };
}

// ── 参照 ────────────────────────────

/** そのスロットにかかっている効果 */
export function effectsOnSlot(
  state: GameState,
  playerId: PlayerId,
  slotId: SlotId,
): ActiveEffect[] {
  const key = effectSlotKey(playerId, slotId);
  return state.effects.filter((e) => isSlotTarget(e.target) && e.target.slotId === key);
}

/** そのプレイヤーにかかっている効果 + 全体にかかっている効果 */
export function effectsOnPlayer(state: GameState, playerId: PlayerId): ActiveEffect[] {
  return state.effects.filter(
    (e) => ('player' in e.target && e.target.player === playerId) || 'global' in e.target,
  );
}

/** 盤面全体・プレイヤー単位の効果（§5.2 の上部バーに出す） */
export function globalEffects(state: GameState): ActiveEffect[] {
  return state.effects.filter((e) => !isSlotTarget(e.target));
}

/**
 * そのスロットにかかっているダメージ修正の合計。
 * ★applyAt でふるい分ける。「与える側」は step2、「受ける側」は step5（§4.1）。
 *   6段パイプラインそのものは T28。ここは合計を出すところまで。
 */
export function damageModifierFor(
  state: GameState,
  playerId: PlayerId,
  slotId: SlotId,
  applyAt: EffectApplyAt,
  targetIsActive = true,
  attackerCard?: CardText | undefined,
): number {
  return damageModifierEffectsFor(
    state,
    playerId,
    slotId,
    applyAt,
    targetIsActive,
    attackerCard,
  ).reduce(
    (sum, e) => sum + (typeof e.payload['delta'] === 'number' ? e.payload['delta'] : 0),
    0,
  );
}

/**
 * その段に効くダメージ修正の一覧。
 *
 * ★スロットにかかっているものだけでは足りない（T43）。
 *   オルタージェネシスGX は「この対戦中、**自分のポケモンが使うワザ**のダメージ+30」なので、
 *   プレイヤー単位でかかる。全体（global）にかかる効果も同じ扱い。
 */
export function damageModifierEffectsFor(
  state: GameState,
  playerId: PlayerId,
  slotId: SlotId,
  applyAt: EffectApplyAt,
  /**
   * ★受ける側がバトルポケモンか（T43）。
   *   オルタージェネシスGX の +30 は「**相手のバトルポケモンへの**ダメージ」だけなので、
   *   ベンチを撃つときは乗らない。payload.onlyAgainstActive がその印。
   */
  targetIsActive = true,
  /**
   * ★効かせる側のポケモン（T44）。
   *   パワータブレットは「自分の**フュージョンの**ポケモンが使うワザ」なので、
   *   プレイヤー単位でかけつつ、乗るポケモンを payload.attackerFilter で絞る。
   */
  attackerCard?: CardText | undefined,
): ActiveEffect[] {
  const matches = (e: ActiveEffect): boolean => {
    if (e.kind !== 'damageModifier' || e.applyAt !== applyAt) return false;
    if (!targetIsActive && e.payload['onlyAgainstActive'] === true) return false;
    const raw = e.payload['attackerFilter'];
    if (raw && typeof raw === 'object') {
      return matchesCardFilter(attackerCard, raw as CardFilter);
    }
    return true;
  };
  return [
    ...effectsOnSlot(state, playerId, slotId).filter(matches),
    ...effectsOnPlayer(state, playerId).filter(matches),
  ];
}

/** 「ワザのダメージを受けない」がかかっているか */
export function preventsAttackDamage(
  state: GameState,
  playerId: PlayerId,
  slotId: SlotId,
): boolean {
  return effectsOnSlot(state, playerId, slotId).some((e) => e.kind === 'preventAttackDamage');
}

const TRAINER_KIND_LABEL: Record<string, string> = {
  item: 'グッズ',
  supporter: 'サポート',
  stadium: 'スタジアム',
  tool: 'ポケモンのどうぐ',
};

/** 画面に出す日本語の一言 */
export function describeEffect(effect: ActiveEffect): string {
  const label = effect.payload['label'];
  if (typeof label === 'string' && label !== '') return label;
  const delta = effect.payload['delta'];
  switch (effect.kind) {
    case 'damageModifier':
      return typeof delta === 'number'
        ? `ダメージ${delta >= 0 ? '+' : ''}${delta}`
        : 'ダメージ修正';
    case 'preventAttackDamage':
      return 'ワザのダメージを受けない';
    case 'preventAttackEffect':
      return 'ワザの効果を受けない';
    case 'cannotRetreat':
      return 'にげられない';
    case 'temporaryTool':
      return '相手の番の終わりにトラッシュ';
    case 'extraAttack':
      return typeof effect.payload['count'] === 'number'
        ? `ワザをあと${effect.payload['count']}回使える`
        : 'ワザを追加で使える';
    case 'cannotUseAttack':
      return 'ワザが使えない';
    case 'lockCardKind': {
      const kinds = effect.payload['trainerKind'];
      const label = Array.isArray(kinds)
        ? kinds.map((k) => TRAINER_KIND_LABEL[String(k)] ?? String(k)).join('・')
        : 'トレーナーズ';
      return `${label}が使えない`;
    }
    case 'extraPrize':
      return typeof delta === 'number' ? `サイドを${delta}枚多くとる` : 'サイドが増える';
    case 'custom':
      return '効果がかかっている';
  }
}

export const DURATION_LABEL: Record<ActiveEffect['duration']['type'], string> = {
  thisTurn: 'この番のあいだ',
  untilEndOfNextOpponentTurn: '次の相手の番の終わりまで',
  untilEndOfNextOwnTurn: '次の自分の番の終わりまで',
  whileSourceInPlay: '発生源が場にあるあいだ',
  wholeGame: '対戦のあいだずっと',
};

// ── 失効（イベント） ──────────────────

/**
 * 場の出来事による失効。
 * ★スロットにかかっている効果は、この4つでは指定によらず必ず消える（§3.2 の表）。
 */
export type EffectEvent =
  | { kind: 'returnsToBench'; slotKey: string }
  | { kind: 'evolves'; slotKey: string }
  | { kind: 'devolves'; slotKey: string }
  | { kind: 'leavesPlay'; slotKey: string };

export function expireOnEvent(state: GameState, event: EffectEvent): void {
  state.effects = state.effects.filter(
    (e) => !(isSlotTarget(e.target) && e.target.slotId === event.slotKey),
  );
}

/**
 * 掃除。毎回の操作のあとに呼ぶ。
 *
 * 落とすもの:
 *   - かかり先のスロットが消えている（きぜつ・回収・場を離れた）
 *   - 発生源が場を離れた（whileSourceInPlay / expiresOn に sourceLeavesPlay）
 */
export function sweepEffects(state: GameState): void {
  state.effects = state.effects.filter((effect) => {
    if (isSlotTarget(effect.target) && !slotExists(state, effect.target.slotId)) return false;

    const needsSource =
      effect.duration.type === 'whileSourceInPlay' ||
      effect.expiresOn.includes('sourceLeavesPlay');
    if (needsSource && effect.source.instanceId !== null) {
      if (!isInPlay(state, effect.source.instanceId)) return false;
    }
    return true;
  });
}

// ── 失効（期間） ───────────────────────

/**
 * 終わった番を見て、期間切れの効果を落とす。
 * endTurn の中で、番が移る前に呼ぶ。
 */
export function expireByDuration(
  state: GameState,
  finishedTurn: number,
  finishedPlayer: PlayerId,
): string[] {
  /**
   * ★期間切れで **カードごと片づける** ものを拾う（T40）。
   *   クレッフィのように「相手の番の終わりにトラッシュする」カードのため。
   *   効果を消すだけでは、どうぐ化したポケモンが場に残ってしまう。
   */
  const toDiscard: string[] = [];
  const survives = (effect: ActiveEffect): boolean => {
    const owner = effect.source.playerId;
    switch (effect.duration.type) {
      case 'thisTurn':
        // かかった番が終わったら消える
        return finishedTurn < effect.createdOnTurn;
      case 'untilEndOfNextOpponentTurn':
        return !(finishedPlayer !== owner && finishedTurn > effect.createdOnTurn);
      case 'untilEndOfNextOwnTurn':
        return !(finishedPlayer === owner && finishedTurn > effect.createdOnTurn);
      case 'whileSourceInPlay':
      case 'wholeGame':
        // 期間では切れない。sweepEffects と場の出来事だけが落とす
        return true;
    }
  };

  state.effects = state.effects.filter((effect) => {
    if (survives(effect)) return true;
    // 期間が切れた。カードごと片づけるものはここで拾う
    const instanceId = effect.payload['instanceId'];
    if (effect.kind === 'temporaryTool' && typeof instanceId === 'string') {
      toDiscard.push(instanceId);
    }
    return false;
  });
  return toDiscard;
}

// ── 特殊状態の消滅（§3.2 の表） ──────────

/**
 * 特殊状態はバトル場のポケモンにしかかからない。
 * ベンチに下がった／入れ替わったスロットからは必ず取り除く。
 */
export function clearConditionsOffActive(state: GameState): void {
  for (const player of Object.values(state.players)) {
    for (const slot of player.pokemon) {
      if (slot.slotId !== 'active' && slot.conditions.length > 0) slot.conditions = [];
    }
  }
}
