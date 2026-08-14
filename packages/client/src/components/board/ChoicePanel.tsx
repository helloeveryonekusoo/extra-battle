/**
 * 効果実行中の選択パネル（第3段階 §5.1 / T25）。
 *
 * ★見せるのは「いま選べるカードだけ」。
 *   山札を見る効果でも、盤面の山札ゾーンは伏せたまま。
 *   このオーバーレイに出ているカードだけが一時的に公開されている。
 *
 * ★相手には「相手が山札を確認しています」しか見せない。
 *   候補は可視性フィルタ（filterStateFor）が空にして送ってくるので、
 *   このファイルは届いたものをそのまま描くだけでよい。
 */
import { useEffect, useState } from 'react';
import type { CardIndex, GameState, Intent, PlayerId } from '@pokeca/shared';
import { CardCompact } from '../card/CardCompact';
import { viewCard } from './boardView';
import styles from './ChoicePanel.module.css';

export interface ChoicePanelProps {
  state: GameState;
  viewerId: PlayerId;
  cardIndex: CardIndex | null;
  intent: (intent: Intent) => void;
  /** 効果を打ち切る（§7-5 の逃げ道） */
  onCancel: () => void;
}

export function ChoicePanel({ state, viewerId, cardIndex, intent, onCancel }: ChoicePanelProps) {
  const choice = state.execution?.pendingChoice ?? null;
  const requestId = choice?.requestId ?? null;
  const [selected, setSelected] = useState<string[]>([]);

  // 別の選択に切り替わったら選び直し
  useEffect(() => {
    setSelected([]);
  }, [requestId]);

  if (!choice) return null;

  const sourceLabel = state.execution?.source.label ?? 'カードの効果';

  if (choice.kind === 'selectOption' && choice.chooser === viewerId) {
    return (
      <div className={styles.backdrop} role="dialog" aria-label="効果を選ぶ">
        <div className={styles.panel}>
          <div className={styles.head}>
            <span className={styles.source}>{sourceLabel}</span>
            <h2 className={styles.title}>{choice.prompt}</h2>
          </div>
          <div className={styles.footer}>
            {choice.candidates.map((id) => (
              <button
                key={id}
                className={`${styles.button} ${styles.primary}`}
                onClick={() => intent({ type: 'resolveChoice', requestId: choice.requestId, selected: [id] })}
              >
                {choice.optionLabels?.[id] ?? id}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── 相手が選んでいる間 ──
  if (choice.chooser !== viewerId) {
    const name = state.players[choice.chooser]?.displayName ?? '相手';
    return (
      <div className={styles.waitingBar} role="status">
        <span className={styles.pulse} />
        {name}が確認しています
        <span className={styles.waitingWhat}>（{sourceLabel}）</span>
      </div>
    );
  }

  // ── 確認するだけ（manual・未自動化のオペコード） ──
  if (choice.kind === 'confirm' || choice.candidates.length === 0) {
    return (
      <div className={styles.backdrop} role="dialog" aria-label="効果の確認">
        <div className={styles.panel}>
          <div className={styles.head}>
            <span className={styles.source}>{sourceLabel}</span>
            <h2 className={styles.title}>手で処理してください</h2>
          </div>
          <p className={styles.prompt}>{choice.prompt}</p>
          <div className={styles.footer}>
            <span className={styles.footNote}>
              自動化していない部分です。盤面を手で動かしてから進めてください。
            </span>
            <button className={styles.button} onClick={onCancel}>
              打ち切る
            </button>
            <button
              className={`${styles.button} ${styles.primary}`}
              onClick={() => intent({ type: 'resolveChoice', requestId: choice.requestId, selected: [] })}
            >
              確認した
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── カードを選ぶ ──
  const toggle = (instanceId: string) => {
    setSelected((prev) => {
      if (prev.includes(instanceId)) return prev.filter((id) => id !== instanceId);
      // 上限まで選んでいたら、いちばん古い選択を押し出す（選び直しやすい）
      const next = prev.length >= choice.max ? prev.slice(1) : prev;
      return [...next, instanceId];
    });
  };

  const enough = choice.allowedCounts
    ? choice.allowedCounts.includes(selected.length)
    : selected.length >= choice.min && selected.length <= choice.max;
  // ★「▲▲まで」なら 0枚のまま抜けられる（§5.1）
  const optional = choice.min === 0;

  return (
    <div className={styles.backdrop} role="dialog" aria-label="カードを選ぶ">
      <div className={styles.panel}>
        <div className={styles.head}>
          <span className={styles.source}>{sourceLabel}</span>
          <h2 className={styles.title}>{choice.prompt}</h2>
          <span className={styles.counter}>
            <b className={enough ? styles.countOk : styles.countShort}>{selected.length}</b>
            <span className={styles.countRange}>
              / {choice.min === choice.max ? choice.max : `${choice.min}〜${choice.max}`}
            </span>
          </span>
        </div>

        <div className={styles.grid}>
          {choice.candidates.map((instanceId) => {
            const view = viewCard(state, cardIndex, instanceId);
            const index = selected.indexOf(instanceId);
            return (
              <button
                key={instanceId}
                className={`${styles.pick} ${index >= 0 ? styles.picked : ''}`}
                aria-pressed={index >= 0}
                aria-label={view?.card?.name ?? '非公開のカード'}
                onClick={() => toggle(instanceId)}
              >
                <CardCompact card={view?.card} faceDown={view?.faceDown ?? false} />
                {index >= 0 && <span className={styles.badge}>{index + 1}</span>}
              </button>
            );
          })}
        </div>

        <div className={styles.footer}>
          <span className={styles.footNote}>
            ここに出ているカードだけが、いまあなたにだけ公開されています。
            選び終わると元どおり伏せられます。
          </span>
          <button className={styles.button} onClick={onCancel}>
            打ち切る
          </button>
          <button
            className={`${styles.button} ${styles.primary}`}
            disabled={!enough}
            onClick={() =>
              intent({ type: 'resolveChoice', requestId: choice.requestId, selected })
            }
          >
            {optional && selected.length === 0 ? '選ばずに完了' : '完了'}
          </button>
        </div>
      </div>
    </div>
  );
}
