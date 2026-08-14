/**
 * 番の進行表示（T13）。
 * 何番目の番か、これまで誰の番だったか、次に追加の番が控えているかを出す。
 */
import type { GameState, PlayerId } from '@pokeca/shared';
import styles from './TurnTrack.module.css';

/** 直近この件数だけ履歴を出す */
const VISIBLE = 14;

export function TurnTrack({ state, viewerId }: { state: GameState; viewerId: PlayerId }) {
  if (state.setup) return null;

  const history = state.turnHistory.slice(-VISIBLE);
  // ★いま進行中の番が追加の番か（§4.4）。列の先頭が進行中の番
  const nowExtra = state.turnQueueMeta[0]?.isExtra ?? false;
  const nowSource = state.turnQueueMeta[0]?.source ?? null;
  // 先頭は進行中の番なので、次に控えているのは index 1
  const nextIsExtra = state.turnQueueMeta[1]?.isExtra ?? false;
  const nextSource = state.turnQueueMeta[1]?.source ?? null;
  const nextPlayer = state.turnQueue[1];

  return (
    <div className={styles.track}>
      <span className={styles.label}>第</span>
      <span className={styles.turnNumber}>{state.turn}</span>
      <span className={styles.label}>番</span>
      {nowExtra && (
        <span className={styles.nowExtra} title={nowSource ? `出どころ: ${nowSource}` : undefined}>
          追加の番{nowSource ? `: ${nowSource}` : ''}
        </span>
      )}

      <div className={styles.history} aria-label="番の履歴">
        {history.map((record, i) => (
          <span
            key={`${record.turn}-${i}`}
            className={`${styles.pip} ${
              record.playerId === viewerId ? styles.pipMine : styles.pipTheirs
            } ${record.isExtra ? styles.pipExtra : ''}`}
            title={`第${record.turn}番 ${state.players[record.playerId]?.displayName ?? record.playerId}${
              record.isExtra ? `（追加${record.source ? `: ${record.source}` : ''}）` : ''
            }`}
          />
        ))}
      </div>

      {nextIsExtra && nextPlayer && (
        <span className={styles.upcoming}>
          次
          <span className={styles.extraTag}>追加の番{nextSource ? `: ${nextSource}` : ''}</span>
        </span>
      )}
    </div>
  );
}
