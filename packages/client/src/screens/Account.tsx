/**
 * アカウント画面（第5段階 T46 / `#account`）。
 *
 * ★ログインは必須にしない。
 *   ローカルで遊ぶだけなら要らない。アカウントが要るのは
 *   「デッキをどの端末でも使う」「オンライン対戦で席を守る」ときだけ。
 */
import { useState, type FormEvent } from 'react';
import {
  authErrorMessage,
  displayNameOf,
  signInWithEmail,
  signInWithGoogle,
  signOutAccount,
  signUpWithEmail,
  useAccount,
} from '../auth/useAuth';
import styles from './Account.module.css';

type Mode = 'signIn' | 'signUp';

export function Account() {
  const { user, loading, available } = useAccount();
  const [mode, setMode] = useState<Mode>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(authErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (mode === 'signUp') await signUpWithEmail(email, password, name);
      else await signInWithEmail(email, password);
    });
  };

  if (!available) {
    return (
      <div className={styles.shell}>
        <div className={styles.panel}>
          <h1 className={styles.title}>アカウント</h1>
          <p className={styles.lead}>
            この端末では Firebase の設定が読み込まれていないため、アカウント機能は使えません。
            ローカルでの対戦とデッキ構築はそのまま使えます。
          </p>
          <a className={styles.link} href="#">
            もどる
          </a>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={styles.shell}>
        <div className={styles.panel}>
          <p className={styles.lead}>確認しています…</p>
        </div>
      </div>
    );
  }

  if (user) {
    return (
      <div className={styles.shell}>
        <div className={styles.panel}>
          <h1 className={styles.title}>アカウント</h1>
          <div className={styles.card}>
            <span className={styles.who}>{displayNameOf(user)}</span>
            {user.email && <span className={styles.mail}>{user.email}</span>}
          </div>
          <p className={styles.lead}>
            デッキはこのアカウントに保存され、別の端末からも使えます。
          </p>
          <div className={styles.row}>
            <button
              type="button"
              className={styles.button}
              disabled={busy}
              onClick={() => void run(signOutAccount)}
            >
              ログアウト
            </button>
            <a className={styles.link} href="#">
              もどる
            </a>
          </div>
          {error && <p className={styles.error}>● {error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <form className={styles.panel} onSubmit={submit}>
        <h1 className={styles.title}>{mode === 'signUp' ? 'アカウントを作る' : 'ログイン'}</h1>
        <p className={styles.lead}>
          デッキを別の端末でも使いたいとき、オンラインで対戦したいときに使います。
          ローカルで遊ぶだけなら不要です。
        </p>

        <div className={styles.tabs}>
          <button
            type="button"
            className={`${styles.tab} ${mode === 'signIn' ? styles.tabActive : ''}`}
            onClick={() => {
              setMode('signIn');
              setError(null);
            }}
          >
            ログイン
          </button>
          <button
            type="button"
            className={`${styles.tab} ${mode === 'signUp' ? styles.tabActive : ''}`}
            onClick={() => {
              setMode('signUp');
              setError(null);
            }}
          >
            新規登録
          </button>
        </div>

        {mode === 'signUp' && (
          <label className={styles.field}>
            <span className={styles.label}>表示名</span>
            <input
              className={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="対戦相手に見える名前"
              maxLength={16}
            />
          </label>
        )}

        <label className={styles.field}>
          <span className={styles.label}>メールアドレス</span>
          <input
            className={styles.input}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>パスワード</span>
          <input
            className={styles.input}
            type="password"
            autoComplete={mode === 'signUp' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {mode === 'signUp' && <small className={styles.hint}>6文字以上</small>}
        </label>

        <div className={styles.row}>
          <button type="submit" className={`${styles.button} ${styles.primary}`} disabled={busy}>
            {mode === 'signUp' ? '登録する' : 'ログイン'}
          </button>
          <button
            type="button"
            className={styles.button}
            disabled={busy}
            onClick={() => void run(signInWithGoogle)}
          >
            Google でログイン
          </button>
          <a className={styles.link} href="#">
            もどる
          </a>
        </div>

        {error && <p className={styles.error}>● {error}</p>}
      </form>
    </div>
  );
}
