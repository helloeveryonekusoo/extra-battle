/**
 * カードデータの読み込み画面（第5段階 T45 / `#cards`）。
 *
 * ★アプリにカードデータを同梱しないので、ここが入口になる。
 *   一度読み込めばブラウザに残る。対戦相手も同じことを一度だけすればよい。
 */
import { useRef, useState, type ChangeEvent } from 'react';
import {
  clearCardPool,
  loadCardPool,
  readCardFile,
  saveCardPool,
  type CardPoolInfo,
} from '../cards/cardPool';
import styles from './CardData.module.css';

export function CardData() {
  const [pool, setPool] = useState<CardPoolInfo>(() => loadCardPool());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const onPick = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    if (files.length === 0) return;
    setError(null);
    setNotice(null);
    try {
      const read = await Promise.all(
        files.map(async (file) => readCardFile(file.name, await file.text())),
      );
      const next = saveCardPool(read, pool);
      setPool(next);
      const added = read.reduce((sum, file) => sum + file.cards.length, 0);
      setNotice(`${read.length}ファイル・${added}枚を読み込みました（合計 ${next.index.all.length}枚）`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'カードデータを読み込めませんでした');
    }
  };

  const byKind = {
    ポケモン: pool.index.all.filter((c) => c.supertype === 'pokemon').length,
    トレーナーズ: pool.index.all.filter((c) => c.supertype === 'trainer').length,
    エネルギー: pool.index.all.filter((c) => c.supertype === 'energy').length,
  };

  return (
    <div className={styles.shell}>
      <div className={styles.panel}>
        <h1 className={styles.title}>カードデータ</h1>
        <p className={styles.lead}>
          このアプリはカードデータを持っていません。手元の JSON を一度だけ読み込んでください。
          読み込んだ内容はこの端末のブラウザにだけ残ります。
        </p>

        {pool.index.all.length === 0 ? (
          <p className={styles.empty}>まだ読み込まれていません</p>
        ) : (
          <div className={styles.summary}>
            <div className={styles.total}>
              <b>{pool.index.all.length}</b>
              <span>枚</span>
            </div>
            <ul className={styles.kinds}>
              {Object.entries(byKind).map(([label, count]) => (
                <li key={label}>
                  <span className={styles.kindLabel}>{label}</span>
                  <span className={styles.kindCount}>{count}</span>
                </li>
              ))}
            </ul>
            {pool.updatedAt && (
              <p className={styles.updated}>
                最終更新 {new Date(pool.updatedAt).toLocaleString('ja-JP')}
              </p>
            )}
          </div>
        )}

        {pool.sources.length > 0 && (
          <ul className={styles.sources}>
            {pool.sources.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        )}

        <div className={styles.row}>
          <button
            type="button"
            className={`${styles.button} ${styles.primary}`}
            onClick={() => inputRef.current?.click()}
          >
            JSONを読み込む
          </button>
          <button
            type="button"
            className={styles.button}
            disabled={pool.index.all.length === 0}
            onClick={() => {
              setPool(clearCardPool());
              setNotice('カードデータを削除しました');
              setError(null);
            }}
          >
            すべて削除
          </button>
          <a className={styles.link} href="#">
            もどる
          </a>
        </div>

        <input
          ref={inputRef}
          className={styles.hidden}
          type="file"
          accept="application/json,.json"
          multiple
          onChange={onPick}
        />

        {notice && <p className={styles.notice}>{notice}</p>}
        {error && <p className={styles.error}>● {error}</p>}

        <p className={styles.hint}>
          同じカードを含むファイルを読み直すと、あとから読んだ内容で置き換わります。
          複数まとめて選べます。
        </p>
      </div>
    </div>
  );
}
