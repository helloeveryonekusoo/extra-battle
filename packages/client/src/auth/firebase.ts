/**
 * Firebase の初期化（第5段階 T46）。
 *
 * ★設定は環境変数から読む。コードに直書きしない（`.env.local` は .gitignore）。
 *   この値は公開しても安全な種類のものだが、
 *   「どのプロジェクトに繋がっているか」をリポジトリに固定したくないため分けてある。
 *
 * ★設定がなくてもアプリを落とさない。
 *   カードデータと同じで、Firebase を使わずローカルで遊ぶ道を塞がない。
 *   使えるかどうかは `firebaseReady` で判断する。
 */
import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';

const env = import.meta.env;

const config = {
  apiKey: env['VITE_FIREBASE_API_KEY'] as string | undefined,
  authDomain: env['VITE_FIREBASE_AUTH_DOMAIN'] as string | undefined,
  projectId: env['VITE_FIREBASE_PROJECT_ID'] as string | undefined,
  storageBucket: env['VITE_FIREBASE_STORAGE_BUCKET'] as string | undefined,
  messagingSenderId: env['VITE_FIREBASE_MESSAGING_SENDER_ID'] as string | undefined,
  appId: env['VITE_FIREBASE_APP_ID'] as string | undefined,
};

/** 設定がそろっているか。そろっていなければ Firebase の機能は出さない */
export const firebaseReady = Boolean(config.apiKey && config.projectId && config.appId);

let app: FirebaseApp | null = null;
let authInstance: Auth | null = null;
let dbInstance: Firestore | null = null;

function ensureApp(): FirebaseApp | null {
  if (!firebaseReady) return null;
  app ??= initializeApp({
    apiKey: config.apiKey ?? '',
    authDomain: config.authDomain ?? '',
    projectId: config.projectId ?? '',
    storageBucket: config.storageBucket ?? '',
    messagingSenderId: config.messagingSenderId ?? '',
    appId: config.appId ?? '',
  });
  return app;
}

export function firebaseAuth(): Auth | null {
  const instance = ensureApp();
  if (!instance) return null;
  authInstance ??= getAuth(instance);
  return authInstance;
}

export function firestore(): Firestore | null {
  const instance = ensureApp();
  if (!instance) return null;
  dbInstance ??= getFirestore(instance);
  return dbInstance;
}
