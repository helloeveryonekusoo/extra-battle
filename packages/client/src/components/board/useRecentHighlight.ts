/**
 * 直近の操作を盤面上で 1.5秒だけ光らせる（§6.8）。
 * 相手が何をしたのか見逃さないための仕掛け。
 */
import { useEffect, useRef, useState } from 'react';
import { actionTargets, slotKey, type GameState, type PlayerId, type SlotId } from '@pokeca/shared';

export const HIGHLIGHT_MS = 1500;

export interface RecentHighlight {
  cardIds: ReadonlySet<string>;
  slots: ReadonlySet<string>;
  isCard: (instanceId: string | undefined) => boolean;
  isSlot: (playerId: PlayerId, slotId: SlotId) => boolean;
}

const EMPTY: RecentHighlight = {
  cardIds: new Set(),
  slots: new Set(),
  isCard: () => false,
  isSlot: () => false,
};

export function useRecentHighlight(state: GameState): RecentHighlight {
  const [targets, setTargets] = useState<{ cardIds: Set<string>; slots: Set<string> } | null>(null);
  const lastSeq = useRef<number | null>(null);

  const latest = state.log[state.log.length - 1];

  useEffect(() => {
    if (!latest) return;
    // 初回描画（既存のログを読み込んだだけ）では光らせない
    if (lastSeq.current === null) {
      lastSeq.current = latest.seq;
      return;
    }
    if (latest.seq === lastSeq.current) return;
    lastSeq.current = latest.seq;

    const { cardIds, slots } = actionTargets(latest.action);
    if (cardIds.length === 0 && slots.length === 0) return;

    setTargets({
      cardIds: new Set(cardIds),
      slots: new Set(slots.map((s) => slotKey(s.playerId, s.slotId))),
    });
    const timer = setTimeout(() => setTargets(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [latest]);

  if (!targets) return EMPTY;

  return {
    cardIds: targets.cardIds,
    slots: targets.slots,
    isCard: (instanceId) => (instanceId ? targets.cardIds.has(instanceId) : false),
    isSlot: (playerId, slotId) => targets.slots.has(slotKey(playerId, slotId)),
  };
}
