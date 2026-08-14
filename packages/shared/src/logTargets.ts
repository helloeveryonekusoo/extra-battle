/**
 * 操作が「どこに触れたか」を取り出す（§6.8）。
 *
 * 使い道は2つ:
 *   - ログの各行に、見えているカードの名前を添える（クリックで詳細を開く）
 *   - 直近の操作を盤面上で 1.5秒だけハイライトする
 *
 * 可視性フィルタを通ったあとの Action を渡すので、
 * 見えないカードは '?' に潰れている。それは呼び出し側で捨てる。
 */
import type { Action } from './actions';
import type { PlayerId, SlotId } from './types';

export const MASKED = '?';

export interface ActionTargets {
  /** 触れたカードの instanceId（見えないものは含めない） */
  cardIds: string[];
  /** 触れた場のスロット */
  slots: { playerId: PlayerId; slotId: SlotId }[];
}

const clean = (ids: readonly (string | null | undefined)[]): string[] =>
  ids.filter((id): id is string => typeof id === 'string' && id !== '' && id !== MASKED);

export function actionTargets(action: Action): ActionTargets {
  const slots: ActionTargets['slots'] = [];
  let cardIds: string[] = [];

  switch (action.type) {
    case 'moveCard':
    case 'setFaceUp':
      cardIds = clean([action.cardId]);
      break;

    case 'setCardVisibility':
    case 'drawCards':
      cardIds = clean(action.cardIds);
      break;

    case 'shuffleIntoDeck':
      cardIds = clean(action.cardIds);
      break;

    case 'setupDeck':
      cardIds = clean(action.cards.map((c) => c.instanceId));
      break;

    case 'placePokemon':
    case 'evolvePokemon':
    case 'attachCard':
    case 'detachCard':
      cardIds = clean([action.cardId]);
      slots.push({ playerId: action.playerId, slotId: action.slotId });
      break;

    case 'knockOut':
      cardIds = clean(action.prizeCardIds);
      slots.push({ playerId: action.playerId, slotId: action.slotId });
      break;

    case 'devolvePokemon':
    case 'removePokemon':
    case 'adjustDamage':
    case 'setDamage':
    case 'setCondition':
    case 'clearConditions':
    case 'setNotes':
    case 'grantAttack':
    case 'clearGrantedAttacks':
      slots.push({ playerId: action.playerId, slotId: action.slotId });
      break;

    case 'movePokemon':
      slots.push(
        { playerId: action.playerId, slotId: action.fromSlotId },
        { playerId: action.playerId, slotId: action.toSlotId },
      );
      break;

    case 'setStadium':
      cardIds = clean([action.cardId]);
      break;

    default:
      break;
  }

  return { cardIds, slots };
}

/** ハイライト用に、スロットを一意なキーへ */
export const slotKey = (playerId: PlayerId, slotId: SlotId): string => `${playerId}/${slotId}`;
