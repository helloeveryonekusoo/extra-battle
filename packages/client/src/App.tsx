import { Suspense, lazy, useEffect, useState } from 'react';
import { useGameStore } from './net/store';
import { Lobby } from './screens/Lobby';
import { Table } from './screens/Table';
import { CardGallery } from './screens/CardGallery';
import { DeckBuilder } from './screens/DeckBuilder';
import { CardData } from './screens/CardData';
import { Account } from './screens/Account';

/**
 * ★開発専用の画面は公開ビルドに入れない（第5段階 T50）。
 *   `import.meta.env.DEV` は本番で `false` に置き換わるので、
 *   この三項演算子ごと畳まれ、中の dynamic import は束ね直しの対象から外れる。
 *   盤面デモは `data/cards/` を読むため、公開する成果物に混ぜてはいけない。
 */
const devScreens = import.meta.env.DEV
  ? {
      board: lazy(() => import('./screens/BoardDemo').then((m) => ({ default: m.BoardDemo }))),
      sync: lazy(() => import('./screens/SyncCheck').then((m) => ({ default: m.SyncCheck }))),
    }
  : null;

/** #cards = カードデータ / #deck = デッキ構築 / #gallery = カード見本 / #account = アカウント */
function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash.replace('#', ''));
  useEffect(() => {
    const onChange = () => setHash(window.location.hash.replace('#', ''));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

export function App() {
  const roomCode = useGameStore((s) => s.roomCode);
  const resume = useGameStore((s) => s.resume);
  const route = useHashRoute();

  // リロードしても同じ席に戻る（★同じネットワークの対戦だけ。オンラインの卓はホストにしかない）
  useEffect(() => {
    resume();
  }, [resume]);

  if (route === 'gallery') {
    return (
      <CardGallery
        onClose={() => {
          window.location.hash = '';
        }}
      />
    );
  }

  if (route === 'deck') return <DeckBuilder />;
  // ★カードデータはアプリに同梱しない。ここで手元から読み込む（T45）
  if (route === 'cards') return <CardData />;
  // ★アカウント（T46）。ログインは必須にしない
  if (route === 'account') return <Account />;

  if (devScreens && (route === 'board' || route === 'sync')) {
    const Screen = devScreens[route];
    return (
      <Suspense fallback={null}>
        <Screen />
      </Suspense>
    );
  }

  return roomCode ? <Table /> : <Lobby />;
}
