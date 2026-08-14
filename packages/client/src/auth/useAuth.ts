/**
 * アカウントの状態（第5段階 T46）。
 *
 * ★エラーは日本語にして返す。Firebase の英語コードをそのまま画面に出さない。
 * ★ログインしていなくてもアプリは使える（ローカル対戦・デッキ構築）。
 *   アカウントは「デッキをどの端末からでも使う」「オンライン対戦の席を守る」ために要る。
 */
import { useEffect, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  type User,
} from 'firebase/auth';
import { firebaseAuth, firebaseReady } from './firebase';

export interface AccountState {
  /** 読み込み中は null と loading:true */
  user: User | null;
  loading: boolean;
  /** Firebase の設定がなければ false。画面はアカウント欄を出さない */
  available: boolean;
}

/** Firebase のエラーコードを日本語にする。知らないものはそのまま出さずに一般化する */
export function authErrorMessage(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : '';
  switch (code) {
    case 'auth/invalid-email':
      return 'メールアドレスの形式が正しくありません';
    case 'auth/missing-password':
      return 'パスワードを入力してください';
    case 'auth/weak-password':
      return 'パスワードは6文字以上にしてください';
    case 'auth/email-already-in-use':
      return 'このメールアドレスはすでに使われています';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'メールアドレスかパスワードが違います';
    case 'auth/too-many-requests':
      return '試行が多すぎます。しばらく待ってからやり直してください';
    case 'auth/network-request-failed':
      return 'ネットワークに繋がりませんでした';
    case 'auth/popup-closed-by-user':
      return 'ログイン画面が閉じられました';
    case 'auth/unauthorized-domain':
      return 'このドメインからのログインは許可されていません（Firebaseの承認済みドメインに追加してください）';
    case 'auth/operation-not-allowed':
      return 'このログイン方法は有効になっていません（Firebaseコンソールで有効にしてください）';
    default:
      return 'ログインできませんでした';
  }
}

export function useAccount(): AccountState {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(firebaseReady);

  useEffect(() => {
    const auth = firebaseAuth();
    if (!auth) {
      setLoading(false);
      return;
    }
    return onAuthStateChanged(auth, (next) => {
      setUser(next);
      setLoading(false);
    });
  }, []);

  return { user, loading, available: firebaseReady };
}

// ── 操作 ────────────────────────────

export async function signUpWithEmail(
  email: string,
  password: string,
  displayName: string,
): Promise<void> {
  const auth = firebaseAuth();
  if (!auth) throw new Error('Firebase の設定がありません');
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  const name = displayName.trim();
  if (name) await updateProfile(credential.user, { displayName: name });
}

export async function signInWithEmail(email: string, password: string): Promise<void> {
  const auth = firebaseAuth();
  if (!auth) throw new Error('Firebase の設定がありません');
  await signInWithEmailAndPassword(auth, email, password);
}

export async function signInWithGoogle(): Promise<void> {
  const auth = firebaseAuth();
  if (!auth) throw new Error('Firebase の設定がありません');
  await signInWithPopup(auth, new GoogleAuthProvider());
}

export async function signOutAccount(): Promise<void> {
  const auth = firebaseAuth();
  if (!auth) return;
  await signOut(auth);
}

/** 画面に出す名前。未設定ならメールの@より前 */
export function displayNameOf(user: User | null): string {
  if (!user) return '';
  if (user.displayName) return user.displayName;
  return user.email ? user.email.split('@')[0] ?? '' : '';
}
