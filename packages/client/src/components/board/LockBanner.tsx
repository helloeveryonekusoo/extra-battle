/**
 * ロック状態の可視化（第4段階 §4.1 / §4.5 / T42）。
 *
 * ★この段階でいちばん大事な画面。
 *   ロックは「押しても何も起きない」形で現れるので、盤面を見ただけでは気づけない。
 *   何が止まっているのかを **常に** 出しておく。
 *
 * ★複数ロックの警告はトーストにしない（§4.5）。
 *   消えるものにすると、見逃したまま自動判定を信じてしまう。
 *   条件が続くあいだは出しっぱなしにする。
 */
import { collectLocks, describeLock, type CardIndex, type GameState, type PlayerId } from '@pokeca/shared';
import styles from './LockBanner.module.css';

export function LockBanner({
  state,
  cardIndex,
  viewerId,
}: {
  state: GameState;
  cardIndex: CardIndex | null;
  viewerId: PlayerId;
}) {
  const locks = collectLocks(state, { cards: cardIndex });
  if (locks.length === 0) return null;

  const multiple = locks.length >= 2;

  return (
    <div className={styles.wrap} aria-label="ロック状態">
      {/* ★消えないバナー（§4.5）。2つ以上あるあいだ出しっぱなしにする */}
      {multiple && (
        <p className={styles.warning} role="status">
          <span className={styles.warnMark}>要確認</span>
          ロック効果が2つ以上出ています。重なった部分は自動判定しません
        </p>
      )}
      <ul className={styles.list}>
        {locks.map((source, i) => (
          <li
            key={`${source.instanceId}-${i}`}
            className={`${styles.item} ${
              source.controllerId === viewerId ? styles.mine : styles.theirs
            }`}
            title={`${source.card.name}：${describeLock(source)}`}
          >
            <span className={styles.side}>
              {source.controllerId === viewerId ? '自分' : '相手'}
            </span>
            <span className={styles.name}>{source.card.name}</span>
            <span className={styles.effect}>{describeLock(source)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
