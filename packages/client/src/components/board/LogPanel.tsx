/**
 * 操作ログパネル（§6.8）。
 *
 * - 全アクションを時系列で表示。相手の操作も含む
 * - 直近の操作はパネル上でも強調する（盤面側のハイライトは Board が担当）
 * - 各エントリに「取り消しを要求」。相手が承認すると巻き戻る
 * - カード名をクリックするとそのカードの詳細が開く
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  actionTargets,
  HIDDEN_FUNCTIONAL_ID,
  type CardIndex,
  type CardText,
  type GameState,
  type LogEntry,
  type PlayerId,
} from '@pokeca/shared';
import { CardFull } from '../card/CardFull';
import styles from './LogPanel.module.css';

export interface LogPanelProps {
  state: GameState;
  cardIndex: CardIndex | null;
  viewerId: PlayerId | null;
  /** 取り消しを要求する。渡さなければ Undo のUIを出さない */
  onRequestUndo?: (targetSeq: number) => void;
  onResolveUndo?: (requestId: string, approve: boolean) => void;
}

/** そのログ行に出てくる、いま自分に見えているカード */
function visibleCards(
  state: GameState,
  cardIndex: CardIndex | null,
  entry: LogEntry,
): { instanceId: string; card: CardText }[] {
  const { cardIds } = actionTargets(entry.action);
  const out: { instanceId: string; card: CardText }[] = [];
  const seen = new Set<string>();
  for (const instanceId of cardIds) {
    if (seen.has(instanceId)) continue;
    seen.add(instanceId);
    const instance = state.cards[instanceId];
    if (!instance || instance.functionalId === HIDDEN_FUNCTIONAL_ID) continue;
    const card = cardIndex?.byFunctionalId.get(instance.functionalId);
    if (card) out.push({ instanceId, card });
  }
  return out;
}

export function LogPanel({
  state,
  cardIndex,
  viewerId,
  onRequestUndo,
  onResolveUndo,
}: LogPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [detail, setDetail] = useState<CardText | null>(null);

  const log = state.log;
  const latestSeq = log[log.length - 1]?.seq;
  const pending = state.pendingUndo;
  const canUndo = Boolean(onRequestUndo) && !pending;

  return (
    <aside className={`${styles.panel} ${collapsed ? styles.collapsed : ''}`}>
      <div className={styles.head}>
        <span>操作ログ</span>
        <button
          className={styles.toggle}
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'ログを開く' : 'ログを閉じる'}
        >
          {collapsed ? '«' : '»'}
        </button>
      </div>

      {!collapsed && pending && (
        <div className={styles.undoBanner}>
          <div className={styles.undoText}>
            {state.players[pending.requestedBy]?.displayName ?? pending.requestedBy} が
            <b> {pending.targetSeq}番以降 </b>
            の取り消しを求めています
          </div>
          {viewerId && pending.requestedBy !== viewerId ? (
            <div className={styles.undoButtons}>
              <button
                className={`${styles.undoButton} ${styles.approve}`}
                onClick={() => onResolveUndo?.(pending.requestId, true)}
              >
                承認して巻き戻す
              </button>
              <button
                className={styles.undoButton}
                onClick={() => onResolveUndo?.(pending.requestId, false)}
              >
                断る
              </button>
            </div>
          ) : (
            <div className={styles.undoWaiting}>相手の返事を待っています…</div>
          )}
        </div>
      )}

      {!collapsed && (
        <div className={styles.body}>
          <div className={styles.rows}>
            {log.length === 0 && <p className={styles.empty}>まだ操作がありません</p>}
            {log.map((entry) => {
              const cards = visibleCards(state, cardIndex, entry);
              return (
                <div
                  key={entry.seq}
                  className={`${styles.row} ${entry.actorId === 'server' ? styles.rowServer : ''} ${
                    entry.seq === latestSeq ? styles.rowLatest : ''
                  } ${entry.undone ? styles.rowUndone : ''}`}
                >
                  <span className={styles.seq}>{entry.seq}</span>
                  <span className={styles.text}>
                    {entry.summary}
                    {entry.warnings.map((w, i) => (
                      <span
                        key={`${w.code}-${i}`}
                        className={`${styles.warning} ${
                          w.severity === 'info' ? styles.warningInfo : ''
                        }`}
                        title={w.code}
                      >
                        {w.severity === 'info' ? 'ℹ' : '⚠'} {w.message}
                      </span>
                    ))}
                    {cards.length > 0 && (
                      <span className={styles.cards}>
                        {cards.map(({ instanceId, card }) => (
                          <button
                            key={instanceId}
                            className={styles.cardChip}
                            onClick={() => setDetail(card)}
                            title="カードの詳細を開く"
                          >
                            {card.name}
                          </button>
                        ))}
                      </span>
                    )}
                  </span>
                  {canUndo && !entry.undone && (
                    <button
                      className={styles.undoRequest}
                      title={`${entry.seq}番以降の操作の取り消しを要求する`}
                      onClick={() => onRequestUndo?.(entry.seq)}
                    >
                      取消
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {detail &&
        createPortal(
          <div className={styles.detailBackdrop} onClick={() => setDetail(null)}>
            <div onClick={(e) => e.stopPropagation()}>
              <CardFull card={detail} />
            </div>
          </div>,
          document.body,
        )}
    </aside>
  );
}
