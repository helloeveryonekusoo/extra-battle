/**
 * ルール警告のトースト（第2段階 §5.1）。
 *
 * - 画面下部に出て3秒で消える
 * - 同じ警告が続いたときはまとめて件数を出す
 * - 警告は LogEntry に入っているので、相手の画面にも同じものが出る
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { GameState, RuleWarning } from '@pokeca/shared';
import styles from './WarningToasts.module.css';

export const TOAST_MS = 3000;

interface Toast {
  id: number;
  warning: RuleWarning;
  count: number;
}

export function WarningToasts({ state }: { state: GameState }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const lastSeq = useRef<number | null>(null);
  const nextId = useRef(0);

  const latest = state.log[state.log.length - 1];

  useEffect(() => {
    if (!latest) return;
    // 読み込み直後の既存ログでは鳴らさない
    if (lastSeq.current === null) {
      lastSeq.current = latest.seq;
      return;
    }
    if (latest.seq === lastSeq.current) return;
    lastSeq.current = latest.seq;
    if (latest.warnings.length === 0) return;

    setToasts((current) => {
      const next = [...current];
      for (const warning of latest.warnings) {
        const same = next.find((t) => t.warning.code === warning.code);
        if (same) same.count += 1;
        else next.push({ id: (nextId.current += 1), warning, count: 1 });
      }
      return next;
    });
  }, [latest]);

  // 3秒で自動消滅
  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setTimeout(() => setToasts((c) => c.slice(1)), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toasts]);

  if (toasts.length === 0) return null;

  return createPortal(
    <div className={styles.stack} role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`${styles.toast} ${toast.warning.severity === 'info' ? styles.info : ''}`}
        >
          <span className={styles.icon} aria-hidden>
            {toast.warning.severity === 'info' ? 'ℹ' : '⚠'}
          </span>
          <span className={styles.message}>{toast.warning.message}</span>
          {toast.count > 1 && <span className={styles.count}>×{toast.count}</span>}
        </div>
      ))}
    </div>,
    document.body,
  );
}
