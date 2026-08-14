/**
 * T46: アカウント。
 *
 * ★ここで守りたいのは2つ。
 *   1. Firebase の英語エラーをそのまま画面に出さない（日本語にして返す）
 *   2. 設定がない端末でもアプリが落ちない（アカウント欄を出さないだけ）
 */
import { describe, expect, it } from 'vitest';
import { authErrorMessage, displayNameOf } from './useAuth';

const err = (code: string) => ({ code });

describe('ログインのエラー表示', () => {
  it.each([
    ['auth/invalid-email', 'メールアドレスの形式が正しくありません'],
    ['auth/weak-password', 'パスワードは6文字以上にしてください'],
    ['auth/email-already-in-use', 'このメールアドレスはすでに使われています'],
    ['auth/invalid-credential', 'メールアドレスかパスワードが違います'],
    ['auth/too-many-requests', '試行が多すぎます。しばらく待ってからやり直してください'],
  ])('%s を日本語にする', (code, expected) => {
    expect(authErrorMessage(err(code))).toBe(expected);
  });

  it('★設定漏れは、原因が分かる文言にする', () => {
    expect(authErrorMessage(err('auth/operation-not-allowed'))).toContain('有効になっていません');
    expect(authErrorMessage(err('auth/unauthorized-domain'))).toContain('承認済みドメイン');
  });

  it('★知らないコードは、英語をそのまま出さない', () => {
    expect(authErrorMessage(err('auth/something-new'))).toBe('ログインできませんでした');
    expect(authErrorMessage(new Error('boom'))).toBe('ログインできませんでした');
    expect(authErrorMessage(null)).toBe('ログインできませんでした');
  });
});

describe('表示名', () => {
  it('表示名があればそれを使う', () => {
    expect(displayNameOf({ displayName: 'つき', email: 'a@b.c' } as never)).toBe('つき');
  });

  it('なければメールの@より前を使う', () => {
    expect(displayNameOf({ displayName: null, email: 'akira@example.com' } as never)).toBe('akira');
  });

  it('ログインしていなければ空', () => {
    expect(displayNameOf(null)).toBe('');
  });
});
