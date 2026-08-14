/**
 * 盤面をさわる最小の道具（T24 で actions.ts から切り出し）。
 *
 * ★ここにあるのは「参照の整合性を保ったままカードを動かす」ためだけの関数。
 *   ルール判定はしないし、ログも残さない。
 *
 * なぜ分けたか:
 *   第3段階の効果インタプリタ（interpreter.ts）も、Action と同じやり方で
 *   カードを動かす必要がある。両方が同じ relocate を使わないと、
 *   position の振り直しや「場を離れたら参照を外す」の扱いが2通りに割れてしまう。
 *   actions.ts と interpreter.ts が互いを import する形（循環）も避けたい。
 */
import type {
  CardInstance,
  GameState,
  PlayerId,
  PlayerState,
  PokemonInPlay,
  SlotId,
  Zone,
} from './types';

/** 山札などへの差し込み位置。position 0 = 山札の一番上 */
export type InsertAt = 'top' | 'bottom' | number;

export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionError';
  }
}

export const playerIdsOf = (state: GameState): PlayerId[] => Object.keys(state.players);

export const zoneForSlot = (slotId: SlotId): Zone => (slotId === 'active' ? 'active' : 'bench');

/**
 * ゾーンに移したときの既定の可視性。
 * ★これは「固定の規則」ではなく、Action が visibleTo を省略したときの初期値にすぎない。
 *   ウラのままバトル場に出す・サイドをオモテにする等は Action 側で明示的に上書きする（§4.3）。
 */
export function defaultVisibilityFor(
  zone: Zone,
  ownerId: PlayerId,
  allPlayers: readonly PlayerId[],
): { visibleTo: PlayerId[]; faceUp: boolean } {
  switch (zone) {
    case 'deck':
    case 'prize':
      return { visibleTo: [], faceUp: false };
    case 'hand':
      return { visibleTo: [ownerId], faceUp: false };
    case 'active':
    case 'bench':
    case 'discard':
    case 'stadium':
    case 'lost':
      // ロストゾーンは両者常時公開
      return { visibleTo: [...allPlayers], faceUp: true };
  }
}

export function getCard(state: GameState, cardId: string): CardInstance {
  const card = state.cards[cardId];
  if (!card) throw new ActionError(`カードが見つかりません: ${cardId}`);
  return card;
}

export function getPlayer(state: GameState, playerId: PlayerId): PlayerState {
  const player = state.players[playerId];
  if (!player) throw new ActionError(`プレイヤーが見つかりません: ${playerId}`);
  return player;
}

export function getSlot(state: GameState, playerId: PlayerId, slotId: SlotId): PokemonInPlay {
  const slot = getPlayer(state, playerId).pokemon.find((p) => p.slotId === slotId);
  if (!slot) throw new ActionError(`スロットが空です: ${playerId} / ${slotId}`);
  return slot;
}

/** (owner, zone) ごとに position を 0 から振り直す */
export function reindexZone(state: GameState, ownerId: PlayerId, zone: Zone): void {
  const inZone = Object.values(state.cards)
    .filter((c) => c.ownerId === ownerId && c.zone === zone)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  inZone.forEach((c, i) => {
    c.position = i;
  });
}

/**
 * 場のあらゆる参照からカードを外す。
 * 進化スタックが空になったスロットは消える。スタジアムなら stadium も null に戻す。
 */
export function detachEverywhere(state: GameState, cardId: string): void {
  for (const player of Object.values(state.players)) {
    player.pokemon = player.pokemon.filter((slot) => {
      slot.stack = slot.stack.filter((id) => id !== cardId);
      slot.attachedEnergy = slot.attachedEnergy.filter((id) => id !== cardId);
      if (slot.attachedTool === cardId) slot.attachedTool = null;
      return slot.stack.length > 0;
    });
  }
  if (state.stadium === cardId) state.stadium = null;
}

/** カードを別ゾーンへ移す。position の振り直しまで面倒を見る */
export function relocate(
  state: GameState,
  cardId: string,
  toZone: Zone,
  at: InsertAt = 'bottom',
  visibility?: { visibleTo?: PlayerId[]; faceUp?: boolean },
): void {
  const card = getCard(state, cardId);
  const fromZone = card.zone;

  detachEverywhere(state, cardId);

  const defaults = defaultVisibilityFor(toZone, card.ownerId, playerIdsOf(state));
  card.zone = toZone;
  card.visibleTo = visibility?.visibleTo ?? defaults.visibleTo;
  card.faceUp = visibility?.faceUp ?? defaults.faceUp;

  // 移動先ゾーンの並びに割り込ませる
  const dest = Object.values(state.cards)
    .filter((c) => c.ownerId === card.ownerId && c.zone === toZone && c.instanceId !== cardId)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  const index =
    at === 'top' ? 0 : at === 'bottom' ? dest.length : Math.max(0, Math.min(at, dest.length));
  dest.splice(index, 0, card);
  dest.forEach((c, i) => {
    c.position = i;
  });

  if (fromZone !== toZone) reindexZone(state, card.ownerId, fromZone);
}

/** 場に出ているカード（スタック・エネルギー・どうぐ）の zone をスロットに合わせる */
export function syncSlotZones(state: GameState, slot: PokemonInPlay): void {
  const zone = zoneForSlot(slot.slotId);
  for (const id of [...slot.stack, ...slot.attachedEnergy, slot.attachedTool ?? '']) {
    const card = state.cards[id];
    if (card) card.zone = zone;
  }
}

/** そのプレイヤーの指定ゾーンのカードを position 順で。山札は index 0 が一番上 */
export function cardsInZoneOf(state: GameState, ownerId: PlayerId, zone: Zone): CardInstance[] {
  return Object.values(state.cards)
    .filter((c) => c.ownerId === ownerId && c.zone === zone)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}
