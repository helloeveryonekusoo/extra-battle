/**
 * 追加の番の告知（第4段階 §4.4 / T41）。
 *
 * ★追加の番が始まった瞬間に、画面中央へ短く出す。
 *   ターン表示のバッジだけだと「相手の番になったはず」と思い込んだまま操作してしまう。
 */
import { motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import type { GameState } from '@pokeca/shared';
import styles from './ExtraTurnBanner.module.css';

/** 出しっぱなしにしない。操作の邪魔になるので短く消す */
export const BANNER_MS = 2200;

/** いま進行中の番が追加の番か。列の先頭が進行中の番を指す */
export const currentTurnIsExtra = (state: GameState): boolean =>
  state.turnQueueMeta[0]?.isExtra ?? false;

export const currentTurnSource = (state: GameState): string | null =>
  state.turnQueueMeta[0]?.source ?? null;

export function ExtraTurnBanner({ state }: { state: GameState }) {
  const [shown, setShown] = useState<{ name: string; source: string | null } | null>(null);
  // 「番が変わったか」を見るために、前回の番号を控える
  const lastTurn = useRef<number | null>(null);

  useEffect(() => {
    const changed = lastTurn.current !== null && lastTurn.current !== state.turn;
    lastTurn.current = state.turn;
    if (!changed || !currentTurnIsExtra(state)) return;

    setShown({
      name: state.players[state.activePlayer]?.displayName ?? state.activePlayer,
      source: currentTurnSource(state),
    });
    const timer = setTimeout(() => setShown(null), BANNER_MS);
    return () => clearTimeout(timer);
  }, [state]);

  // ★消えるときはアニメーションを挟まない。
  //   「もう出ていない」ことが状態から一目で分かるほうが、見るのもテストするのも確実
  if (!shown) return null;
  return (
    <motion.div
      className={styles.banner}
      role="status"
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
    >
      <span className={styles.title}>追加の番</span>
      <span className={styles.detail}>
        {shown.name}
        {shown.source && <span className={styles.source}>{shown.source}</span>}
      </span>
    </motion.div>
  );
}
