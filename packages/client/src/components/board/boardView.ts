/**
 * GameState を「描くための形」に読み替える層。
 *
 * ここでは可視性の判断をやり直さない。サーバーが filterStateFor を通した結果だけを見て、
 * functionalId が空なら「見えないカード」として扱う。
 */
import {
  benchLimitDetail,
  cardsInZone,
  effectiveProfileOf,
  energyOnSlot,
  getBenchLimit,
  getEffectiveAbilityEntries,
  effectSlotKey,
  playLockFor,
  HIDDEN_FUNCTIONAL_ID,
  type CardIndex,
  type CardText,
  type EffectiveProfile,
  type EnergyType,
  type GameState,
  type PlayerId,
  type PokemonInPlay,
  type SlotId,
  type Zone,
} from '@pokeca/shared';

export interface CardView {
  instanceId: string;
  /** 見えないカードなら undefined */
  card: CardText | undefined;
  faceDown: boolean;
}

export interface SlotView {
  slotId: SlotId;
  slot: PokemonInPlay | undefined;
  /** 進化スタックの一番上 */
  top: CardView | undefined;
  /** ★1粒＝エネルギー1個ぶん。カードの枚数ではない（T33） */
  energy: EnergyType[];
  /** 「何個ぶん」の内訳。マウスを乗せたときに出す */
  energyTitle: string;
  /** BREAK進化を合成した姿（T37）。ワザ・弱点・にげるの出どころを含む */
  profile: EffectiveProfile;
  /** BREAK進化しているとき、下に敷かれているカードの名前。§4.3 の横向き表示に使う */
  breakUnder: string | null;
  toolName: string | null;
  /**
   * ★どうぐが「相手のカード」かどうか（フレア団ハイパーギア。T40）。
   *   `attachedTool` の持ち主と装着先が違うケースがあるので、見て分かるようにする。
   */
  toolIsOpponents: boolean;
  stackSize: number;
  /**
   * ★特性の一覧と、それが止まっているか（§4.1 / T42）。
   *   止まっていても消さない。グレーアウト＋取り消し線で「あるのに使えない」と見せる。
   */
  abilities: AbilityView[];
}

export interface AbilityView {
  name: string;
  locked: boolean;
  /** ロックが複数あり、自動判定を信用しない（§2.1） */
  assisted: boolean;
  /** ホバーで出す理由 */
  reason: string;
}

export function viewCard(
  state: GameState,
  index: CardIndex | null,
  instanceId: string | null | undefined,
): CardView | undefined {
  if (!instanceId) return undefined;
  const instance = state.cards[instanceId];
  if (!instance) return undefined;
  const hidden = instance.functionalId === HIDDEN_FUNCTIONAL_ID;
  return {
    instanceId,
    card: hidden ? undefined : index?.byFunctionalId.get(instance.functionalId),
    faceDown: hidden,
  };
}

/**
 * 盤面に描くエネルギーの粒。
 *
 * ★カードの枚数ではなく「何個ぶんはたらくか」で描く（T33）。
 *   ダブル無色エネルギー1枚なら粒は2つ。
 *   ツインエネルギーをルールを持つポケモンにつけていれば、はたらかないので粒は0。
 *   計算は派生状態レイヤ（energyOnSlot）に任せる。ここでは色を選ぶだけ。
 */
function energyPips(
  state: GameState,
  index: CardIndex | null,
  playerId: PlayerId,
  slotId: SlotId,
): { pips: EnergyType[]; title: string } {
  const values = energyOnSlot(state, playerId, slotId, { cards: index });
  const pips: EnergyType[] = [];
  for (const value of values) {
    // 「好きなタイプ」は色を決められないので無色の粒で置く
    const color = value.types === 'any' ? 'colorless' : (value.types[0] ?? 'colorless');
    for (let i = 0; i < value.amount; i += 1) pips.push(color);
  }
  const total = values.reduce((sum, value) => sum + value.amount, 0);
  const detail = values.map((value) => value.label).join(' / ');
  return {
    pips,
    title: values.length === 0 ? '' : `エネルギー ${total}個ぶん（${values.length}枚）${detail ? `: ${detail}` : ''}`,
  };
}

export function slotViewOf(
  state: GameState,
  index: CardIndex | null,
  playerId: PlayerId,
  slotId: SlotId,
): SlotView {
  const slot = state.players[playerId]?.pokemon.find((p) => p.slotId === slotId);
  if (!slot) {
    return {
      slotId,
      slot: undefined,
      top: undefined,
      energy: [],
      energyTitle: '',
      profile: effectiveProfileOf(state, playerId, slotId, { cards: index }),
      breakUnder: null,
      toolName: null,
      toolIsOpponents: false,
      stackSize: 0,
      abilities: [],
    };
  }
  const topId = slot.stack[slot.stack.length - 1];
  const tool = viewCard(state, index, slot.attachedTool);
  const energy = energyPips(state, index, playerId, slotId);
  const profile = effectiveProfileOf(state, playerId, slotId, { cards: index });
  return {
    slotId,
    slot,
    top: viewCard(state, index, topId),
    energy: energy.pips,
    energyTitle: energy.title,
    profile,
    // ★BREAK進化なら、下に敷かれているカードの名前を出す（§4.3）
    breakUnder: profile.isBreak ? (profile.base?.card?.name ?? '進化前のカード') : null,
    toolName: slot.attachedTool ? (tool?.card?.name ?? '非公開') : null,
    toolIsOpponents: Boolean(
      slot.attachedTool && state.cards[slot.attachedTool]?.ownerId !== playerId,
    ),
    stackSize: slot.stack.length,
    // ★止まっている特性も一覧に残す（§4.1）
    abilities: getEffectiveAbilityEntries(state, effectSlotKey(playerId, slotId), {
      cards: index,
    }).map((entry) => ({
      name: entry.ability.name,
      locked: entry.lock.locked,
      assisted: entry.lock.assisted,
      reason: entry.lock.reason,
    })),
  };
}

/**
 * 手札のカードが、いまロックで使えない状態か（§4.1）。
 * ★使えなくても操作は止めない。暗くして理由を出すだけ（第2段階 §2）。
 */
export function handLockOf(
  state: GameState,
  index: CardIndex | null,
  playerId: PlayerId,
  card: CardText | undefined,
): { locked: boolean; reason: string } {
  // ★トレーナーズの種別だけでなく、特殊エネルギーのような指定も同じ窓口で見る（T43）
  const verdict = playLockFor(state, playerId, card, { cards: index });
  return {
    locked: verdict.locked,
    reason: verdict.locked
      ? verdict.reason + (verdict.assisted ? '（ロックが複数。要確認）' : '')
      : '',
  };
}

/** ベンチの空き数と、その内訳（§4.1 のツールチップ） */
export function benchInfo(
  state: GameState,
  playerId: PlayerId,
  index: CardIndex | null = null,
): { limit: number; used: number; free: number; title: string } {
  const detail = benchLimitDetail(state, playerId, { cards: index });
  const over = detail.used > detail.limit;
  return {
    limit: detail.limit,
    used: detail.used,
    free: detail.free,
    title:
      `ベンチ ${detail.used}/${detail.limit}（空き${detail.free}）` +
      (detail.sources.length > 0 ? `｜${detail.sources.join(' / ')}` : '｜既定') +
      // ★上限を下げた結果あふれることがある。減らすのは手動（§2.3）
      (over ? '｜上限を超えています。どれを残すかは手で決めてください' : ''),
  };
}

/**
 * 描くベンチのスロット一覧。
 * ★ベンチ上限は可変（§5.1-1）。上限より多く埋まっている場合もあるので、
 *   「上限」と「実際に埋まっている数」の大きいほうまで出す。
 */
export function benchSlotIds(
  state: GameState,
  playerId: PlayerId,
  index: CardIndex | null = null,
): SlotId[] {
  const player = state.players[playerId];
  if (!player) return [];
  const used = player.pokemon
    .filter((p) => p.slotId !== 'active')
    .map((p) => Number(p.slotId.slice('bench-'.length)));
  const highest = used.length > 0 ? Math.max(...used) + 1 : 0;
  // 上限は派生状態から出す（スカイフィールド8 / ウソッキー4 の合成。T27）
  const count = Math.max(getBenchLimit(state, playerId, { cards: index }), highest);
  return Array.from({ length: count }, (_, i) => `bench-${i}` as SlotId);
}

export function zoneCount(state: GameState, playerId: PlayerId, zone: Zone): number {
  return cardsInZone(state, playerId, zone).length;
}

/** ドラッグ用の荷物を作る。場から動かすときは fromSlotId を添える */
export function dragPayloadFor(
  state: GameState,
  index: CardIndex | null,
  instanceId: string,
  fromSlotId?: SlotId,
): {
  instanceId: string;
  ownerId: PlayerId;
  fromZone: Zone;
  fromSlotId?: SlotId;
  card: CardText | undefined;
  faceDown: boolean;
} | null {
  const instance = state.cards[instanceId];
  if (!instance) return null;
  const view = viewCard(state, index, instanceId);
  return {
    instanceId,
    ownerId: instance.ownerId,
    fromZone: instance.zone,
    ...(fromSlotId ? { fromSlotId } : {}),
    card: view?.card,
    faceDown: view?.faceDown ?? true,
  };
}

export function handViews(
  state: GameState,
  index: CardIndex | null,
  playerId: PlayerId,
): CardView[] {
  return cardsInZone(state, playerId, 'hand')
    .map((c) => viewCard(state, index, c.instanceId))
    .filter((v): v is CardView => v !== undefined);
}
