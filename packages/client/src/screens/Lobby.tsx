/**
 * ロビー。ここで接続先を選ぶ（第5段階 T48）。
 *
 *   オンライン       … アカウントで席を守り、ホストのブラウザが持つ卓に繋ぐ
 *   同じネットワーク … 手元で動かした WebSocket サーバーに繋ぐ（第2段階からのしくみ）
 *
 * ★名前・デッキ・部屋コードはどちらでも同じものを使う。
 *   接続先ごとに入力欄を分けると、同じことを2回書かせることになる。
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useGameStore, type TransportMode } from '../net/store';
import { getSelectedDeckId, setSelectedDeckId } from '../decks/deckStorage';
import { loadLibrary, type SavedDeck } from '../decks/deckLibrary';
import { loadCardPool } from '../cards/cardPool';
import { displayNameOf, useAccount } from '../auth/useAuth';
import styles from './Lobby.module.css';

export function Lobby() {
  const {
    status,
    error,
    createRoom,
    joinRoom,
    createOnlineRoom,
    joinOnlineRoom,
    clearError,
  } = useGameStore();
  const storedName = useGameStore((s) => s.displayName);
  const { user, available } = useAccount();
  const uid = user?.uid ?? null;

  const [mode, setMode] = useState<TransportMode>(available ? 'online' : 'local');
  const [name, setName] = useState(storedName);
  const [code, setCode] = useState('');
  const [savedDecks, setSavedDecks] = useState<SavedDeck[]>([]);
  const [deckId, setDeckId] = useState('');
  const [pool] = useState(() => loadCardPool());

  // ログインしたら、まだ何も書いていない名前欄をアカウント名で埋める
  useEffect(() => {
    const fromAccount = displayNameOf(user);
    if (fromAccount) setName((current) => current || fromAccount);
  }, [user]);

  // ★デッキの置き場はログイン状態で変わる（T47）。呼び分けは deckLibrary に任せる
  useEffect(() => {
    let alive = true;
    void loadLibrary(uid).then((library) => {
      if (!alive) return;
      setSavedDecks(library.decks);
      const selected = getSelectedDeckId();
      setDeckId(
        library.decks.some((deck) => deck.id === selected)
          ? selected
          : (library.decks[0]?.id ?? ''),
      );
    });
    return () => {
      alive = false;
    };
  }, [uid]);

  const selectedDeck = savedDecks.find((deck) => deck.id === deckId);
  const submittedDeck = selectedDeck
    ? { name: selectedDeck.name, cards: selectedDeck.cards }
    : undefined;

  const busy = status === 'connecting' || status === 'reconnecting';
  const online = mode === 'online';
  // ★オンラインは席をアカウントで守る。ログインしていないと始められない
  const blocked = online && !uid;
  const trimmed = name.trim();
  const canHost = !busy && !blocked && trimmed.length > 0;
  const canJoin = canHost && code.trim().length === 6;

  const start = (kind: 'host' | 'join') => {
    clearError();
    if (online) {
      if (!uid) return;
      const options = { uid, displayName: trimmed, ...(submittedDeck ? { deck: submittedDeck } : {}) };
      if (kind === 'host') void createOnlineRoom(options);
      else void joinOnlineRoom(code, options);
      return;
    }
    if (kind === 'host') createRoom(trimmed, submittedDeck);
    else joinRoom(code, trimmed, submittedDeck);
  };

  const submitJoin = (e: FormEvent) => {
    e.preventDefault();
    if (canJoin) start('join');
  };

  return (
    <div className={styles.shell}>
      <form className={styles.panel} onSubmit={submitJoin}>
        <h1 className={styles.title}>ポケカ エクストラ 対戦卓</h1>
        <p className={styles.subtitle}>ルールは人間が守る。アプリは盤面を合わせるだけ。</p>

        <div className={styles.field} role="radiogroup" aria-label="接続先">
          <span className={styles.label}>接続先</span>
          <div className={styles.modes}>
            <button
              type="button"
              role="radio"
              aria-checked={online}
              className={`${styles.mode} ${online ? styles.modeOn : ''}`}
              onClick={() => setMode('online')}
              disabled={!available}
            >
              オンライン
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={!online}
              className={`${styles.mode} ${!online ? styles.modeOn : ''}`}
              onClick={() => setMode('local')}
            >
              同じネットワーク
            </button>
          </div>
          <small className={styles.deckHint}>
            {online
              ? '離れた場所と対戦できます。部屋を作った側のブラウザが卓を持ちます（閉じると対戦は終わります）。'
              : '同じネットワークの中だけ。先に pnpm dev:server を起動してください。'}
          </small>
        </div>

        <label className={styles.field}>
          <span className={styles.label}>プレイヤー名</span>
          <input
            className={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="あなたの名前"
            maxLength={16}
          />
        </label>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="match-deck">対戦に使うデッキ</label>
          <div className={styles.deckRow}>
            <select
              id="match-deck"
              className={styles.input}
              value={deckId}
              onChange={(e) => {
                setDeckId(e.target.value);
                setSelectedDeckId(e.target.value);
              }}
            >
              <option value="">デッキを選ばない</option>
              {savedDecks.map((deck) => (
                <option key={deck.id} value={deck.id}>
                  {deck.name}（{deck.cards.reduce((sum, card) => sum + card.count, 0)}枚）
                </option>
              ))}
            </select>
            <a className={styles.deckButton} href="#deck">構築・編集</a>
          </div>
          <small className={styles.deckHint}>
            {selectedDeck
              ? `「${selectedDeck.name}」を入室時に読み込みます。ルールエラーがあっても操作は止めません。`
              : '保存デッキがない場合は、入室後に開発用デッキを置くこともできます。'}
          </small>
        </div>

        {blocked && (
          <p className={styles.notice}>
            オンライン対戦にはアカウントが要ります（席を他人に取られないようにするため）。
            <br />
            <a className={styles.link} href="#account">ログイン・新規登録へ</a>
          </p>
        )}

        {online && !blocked && pool.index.all.length === 0 && (
          <p className={styles.notice}>
            この端末にカードデータがありません。デッキのカードを卓が知らないと席に着けません。
            <br />
            <a className={styles.link} href="#cards">カードデータを読み込む</a>
          </p>
        )}

        <div className={styles.row}>
          <button
            type="button"
            className={`${styles.button} ${styles.primary}`}
            disabled={!canHost}
            onClick={() => start('host')}
          >
            部屋を作る
          </button>
        </div>

        <hr className={styles.divider} />

        <label className={styles.field}>
          <span className={styles.label}>部屋コードで参加</span>
          <input
            className={`${styles.input} ${styles.code}`}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABC123"
            maxLength={6}
            autoComplete="off"
          />
        </label>

        <div className={styles.row}>
          <button type="submit" className={styles.button} disabled={!canJoin}>
            参加する
          </button>
        </div>

        {error && <p className={styles.error}>{error}</p>}

        <p className={styles.note}>
          <a className={styles.link} href="#cards">カードデータ</a>
          {' / '}
          <a className={styles.link} href="#deck">デッキ構築</a>
          {' / '}
          <a className={styles.link} href="#account">
            {uid ? `アカウント（${displayNameOf(user)}）` : 'アカウント'}
          </a>
          {' / '}
          <a className={styles.link} href="#gallery">カード見本</a>
          {/* ★盤面デモは開発専用。公開ビルドには入っていないのでリンクも出さない */}
          {import.meta.env.DEV && (
            <>
              {' / '}
              <a className={styles.link} href="#board">盤面デモ</a>
            </>
          )}
        </p>
      </form>
    </div>
  );
}
