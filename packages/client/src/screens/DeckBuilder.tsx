import { useEffect, useMemo, useRef, useState, type ChangeEvent, type WheelEvent } from 'react';
import {
  ENERGY_TYPES,
  validateDeck,
  type CardText,
  type DeckEntry,
  type EnergyType,
} from '@pokeca/shared';
import { loadCardPool } from '../cards/cardPool';
import { deleteDeckFrom, loadLibrary, saveDeckTo } from '../decks/deckLibrary';
import { useAccount } from '../auth/useAuth';
import { CardCompact } from '../components/card/CardCompact';
import {
  getSelectedDeckId,
  listSavedDecks,
  parseDeckFile,
  serializeDeck,
  setSelectedDeckId,
  type SavedDeck,
} from '../decks/deckStorage';
import styles from './DeckBuilder.module.css';

type KindFilter = 'all' | 'pokemon' | 'item' | 'tool' | 'supporter' | 'stadium' | 'energy';

const KIND_LABEL: Record<KindFilter, string> = {
  all: 'すべての種類',
  pokemon: 'ポケモン',
  item: 'グッズ',
  tool: 'ポケモンのどうぐ',
  supporter: 'サポート',
  stadium: 'スタジアム',
  energy: 'エネルギー',
};

const TYPE_LABEL: Record<EnergyType, string> = {
  grass: '草',
  fire: '炎',
  water: '水',
  lightning: '雷',
  psychic: '超',
  fighting: '闘',
  darkness: '悪',
  metal: '鋼',
  fairy: '妖',
  dragon: '竜',
  colorless: '無色',
};

const GROUPS = [
  ['pokemon', 'ポケモン'],
  ['item', 'グッズ'],
  ['tool', 'ポケモンのどうぐ'],
  ['supporter', 'サポート'],
  ['stadium', 'スタジアム'],
  ['energy', 'エネルギー'],
] as const;

type GroupKey = (typeof GROUPS)[number][0];

function groupOf(card: CardText): GroupKey {
  if (card.supertype === 'pokemon') return 'pokemon';
  if (card.supertype === 'energy') return 'energy';
  return card.trainerKind ?? 'item';
}

function matchesKind(card: CardText, kind: KindFilter): boolean {
  if (kind === 'all') return true;
  return groupOf(card) === kind;
}

function deckCards(counts: Readonly<Record<string, number>>) {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([functionalId, count]) => ({ functionalId, count }));
}

function snapshot(name: string, counts: Readonly<Record<string, number>>): string {
  return JSON.stringify({ name, cards: deckCards(counts).sort((a, b) => a.functionalId.localeCompare(b.functionalId)) });
}

export function DeckBuilder() {
  /*
   * ★デッキの置き場は「ログインしているか」だけで決まる（T47）。
   *   ログイン中はアカウント（Firestore）、そうでなければこの端末。
   *   呼び分けは deckLibrary に閉じ込めてあるので、ここでは uid を渡すだけ。
   */
  const { user } = useAccount();
  const uid = user?.uid ?? null;
  const [where, setWhere] = useState<'cloud' | 'local'>('local');
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [savedDecks, setSavedDecks] = useState<SavedDeck[]>(() => listSavedDecks());
  const initial = savedDecks.find((deck) => deck.id === getSelectedDeckId()) ?? savedDecks[0];
  const [currentId, setCurrentId] = useState(initial?.id ?? '');
  const [name, setName] = useState(initial?.name ?? '新しいデッキ');
  const [counts, setCounts] = useState<Record<string, number>>(() =>
    Object.fromEntries((initial?.cards ?? []).map((card) => [card.functionalId, card.count])),
  );
  const [savedSnapshot, setSavedSnapshot] = useState(() => snapshot(name, counts));

  // ログイン状態が変われば、置き場ごと読み直す
  useEffect(() => {
    let alive = true;
    void (async () => {
      const library = await loadLibrary(uid);
      if (!alive) return;
      setSavedDecks(library.decks);
      setWhere(library.where);
      setLibraryError(library.error);
    })();
    return () => {
      alive = false;
    };
  }, [uid]);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [energyType, setEnergyType] = useState<EnergyType | 'all'>('all');
  const [notice, setNotice] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  // ★同梱せず、手元に読み込んだプールを使う（T45）
  const pool = useMemo(() => loadCardPool().index, []);
  const cards = pool.all;
  const filteredCards = useMemo(() => {
    const needle = query.normalize('NFKC').toLocaleLowerCase('ja');
    return cards.filter((card) => {
      const searchable = `${card.name} ${card.text ?? ''}`.normalize('NFKC').toLocaleLowerCase('ja');
      return (
        (!needle || searchable.includes(needle)) &&
        matchesKind(card, kind) &&
        (energyType === 'all' ||
          card.types?.includes(energyType) ||
          card.energyProvides?.includes(energyType))
      );
    });
  }, [cards, energyType, kind, query]);

  const entries = useMemo<DeckEntry[]>(
    () =>
      deckCards(counts).flatMap((line): DeckEntry[] => {
        const card = pool.byFunctionalId.get(line.functionalId);
        return card ? [{ card, count: line.count }] : [];
      }),
    [counts],
  );
  const issues = useMemo(() => validateDeck(entries), [entries]);
  const total = deckCards(counts).reduce((sum, card) => sum + card.count, 0);
  const dirty = snapshot(name, counts) !== savedSnapshot;
  const unknownIds = deckCards(counts)
    .filter((line) => !pool.byFunctionalId.has(line.functionalId))
    .map((line) => line.functionalId);

  const changeCount = (functionalId: string, delta: number) => {
    setCounts((current) => {
      const next = Math.max(0, Math.min(99, (current[functionalId] ?? 0) + delta));
      return { ...current, [functionalId]: next };
    });
    setNotice(null);
  };

  const openDeck = (id: string) => {
    const deck = savedDecks.find((item) => item.id === id);
    if (!deck) return;
    const nextCounts = Object.fromEntries(deck.cards.map((card) => [card.functionalId, card.count]));
    setCurrentId(deck.id);
    setSelectedDeckId(deck.id);
    setName(deck.name);
    setCounts(nextCounts);
    setSavedSnapshot(snapshot(deck.name, nextCounts));
    setNotice(`「${deck.name}」を開きました`);
    setImportError(null);
  };

  const createNew = () => {
    setCurrentId('');
    setName('新しいデッキ');
    setCounts({});
    setSavedSnapshot(snapshot('新しいデッキ', {}));
    setNotice(null);
    setImportError(null);
  };

  const persist = () => {
    void (async () => {
      try {
        const saved = await saveDeckTo(
          uid,
          { name: name.trim() || '名前のないデッキ', cards: deckCards(counts) },
          currentId || undefined,
        );
        setCurrentId(saved.id);
        setName(saved.name);
        setSelectedDeckId(saved.id);
        setSavedDecks((await loadLibrary(uid)).decks);
        setSavedSnapshot(snapshot(saved.name, counts));
        setNotice(
          `「${saved.name}」を保存しました（${uid ? 'アカウント' : 'この端末'}）`,
        );
        setLibraryError(null);
      } catch (cause) {
        setLibraryError(cause instanceof Error ? cause.message : '保存できませんでした');
      }
    })();
  };

  const removeCurrent = () => {
    if (!currentId) return;
    void (async () => {
      try {
        await deleteDeckFrom(uid, currentId);
        setSavedDecks((await loadLibrary(uid)).decks);
        setCurrentId('');
        setNotice('保存デッキを削除しました。編集中の内容は残っています。');
        setLibraryError(null);
      } catch {
        setLibraryError('削除できませんでした');
      }
    })();
  };

  const exportJson = () => {
    const blob = new Blob([serializeDeck({ name: name.trim() || '名前のないデッキ', cards: deckCards(counts) })], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${(name.trim() || 'deck').replace(/[\\/:*?"<>|]/g, '_')}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice('デッキJSONを書き出しました');
  };

  const importJson = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const imported = parseDeckFile(await file.text());
      const unknown = imported.cards.filter((line) => !pool.byFunctionalId.has(line.functionalId));
      if (unknown.length > 0) throw new Error(`カードプールにないIDがあります: ${unknown.map((line) => line.functionalId).join(', ')}`);
      const nextCounts = Object.fromEntries(imported.cards.map((line) => [line.functionalId, line.count]));
      setCurrentId('');
      setName(imported.name);
      setCounts(nextCounts);
      setSavedSnapshot('');
      setNotice('JSONを読み込みました。内容を確認して保存してください。');
      setImportError(null);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'JSONを読み込めませんでした');
    }
  };

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <a className={styles.back} href="#">← ロビー</a>
        <div className={styles.titleBlock}>
          <label className={styles.nameLabel} htmlFor="deck-name">デッキ名</label>
          <input id="deck-name" className={styles.nameInput} value={name} maxLength={40} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className={`${styles.total} ${issues.length === 0 ? styles.totalOk : styles.totalError}`}>
          <strong>{total}</strong> / 60 <span>{issues.length === 0 ? '✓' : '!'}</span>
        </div>
        <div className={styles.headerActions}>
          <button onClick={createNew}>新規</button>
          <button onClick={() => importRef.current?.click()}>JSON読込</button>
          <button onClick={exportJson}>JSON書出</button>
          <button className={styles.primary} onClick={persist}>保存</button>
          <input ref={importRef} className={styles.hiddenInput} type="file" accept="application/json,.json" onChange={importJson} />
        </div>
      </header>

      <div className={styles.workspace}>
        <section className={styles.catalog} aria-label="カードカタログ">
          <div className={styles.filters}>
            <input aria-label="カード検索" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="カード名・テキストを検索" />
            <select aria-label="種類" value={kind} onChange={(event) => setKind(event.target.value as KindFilter)}>
              {Object.entries(KIND_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <select aria-label="タイプ" value={energyType} onChange={(event) => setEnergyType(event.target.value as EnergyType | 'all')}>
              <option value="all">すべてのタイプ</option>
              {ENERGY_TYPES.map((type) => <option key={type} value={type}>{TYPE_LABEL[type]}</option>)}
            </select>
            <select aria-label="収録弾" disabled title="サンプルカードには印刷情報がありません">
              <option>すべての弾（版情報なし）</option>
            </select>
          </div>
          <div className={styles.catalogMeta}>{filteredCards.length}種類　ホイールでも枚数を変更できます</div>
          <div className={styles.cardGrid}>
            {filteredCards.map((card) => {
              const count = counts[card.functionalId] ?? 0;
              return (
                <article
                  key={card.functionalId}
                  className={`${styles.cardChoice} ${count > 0 ? styles.cardSelected : ''}`}
                  onWheel={(event: WheelEvent) => {
                    event.preventDefault();
                    changeCount(card.functionalId, event.deltaY < 0 ? 1 : -1);
                  }}
                >
                  <CardCompact card={card} onClick={() => changeCount(card.functionalId, 1)} />
                  <div className={styles.cardControls}>
                    <button aria-label={`${card.name}を1枚減らす`} onClick={() => changeCount(card.functionalId, -1)}>−</button>
                    <output aria-label={`${card.name}の枚数`}>{count}</output>
                    <button aria-label={`${card.name}を1枚増やす`} onClick={() => changeCount(card.functionalId, 1)}>＋</button>
                  </div>
                </article>
              );
            })}
            {filteredCards.length === 0 && <p className={styles.empty}>条件に合うカードがありません</p>}
          </div>
        </section>

        <aside className={styles.deckPanel} aria-label="構築中のデッキ">
          <div className={styles.savedBar}>
            <label htmlFor="saved-deck">保存デッキ</label>
            {/* ★どこに保存されるかを常に見せる（T47） */}
            <span
              className={styles.where}
              title={
                where === 'cloud'
                  ? 'ログイン中。デッキはアカウントに保存され、別の端末でも使えます'
                  : 'ログアウト中。デッキはこの端末にだけ保存されます'
              }
            >
              {where === 'cloud' ? 'アカウント' : 'この端末'}
            </span>
            <select id="saved-deck" value={currentId} onChange={(event) => openDeck(event.target.value)}>
              <option value="">編集中（未保存）</option>
              {savedDecks.map((deck) => <option key={deck.id} value={deck.id}>{deck.name}（{deck.cards.reduce((sum, line) => sum + line.count, 0)}枚）</option>)}
            </select>
            <button disabled={!currentId} onClick={removeCurrent}>削除</button>
          </div>
          <div className={styles.deckList}>
            {GROUPS.map(([group, label]) => {
              const lines = entries.filter((entry) => groupOf(entry.card) === group);
              const subtotal = lines.reduce((sum, entry) => sum + entry.count, 0);
              if (lines.length === 0) return null;
              return (
                <section key={group} className={styles.group}>
                  <h2><span>{label}</span><b>{subtotal}</b></h2>
                  {lines.map((entry) => (
                    <div className={styles.deckLine} key={entry.card.functionalId}>
                      <span className={styles.lineCount}>{entry.count}</span>
                      <span className={styles.lineName}>{entry.card.name}</span>
                      <button aria-label={`${entry.card.name}を1枚減らす`} onClick={() => changeCount(entry.card.functionalId, -1)}>−</button>
                      <button aria-label={`${entry.card.name}を1枚増やす`} onClick={() => changeCount(entry.card.functionalId, 1)}>＋</button>
                    </div>
                  ))}
                </section>
              );
            })}
            {entries.length === 0 && unknownIds.length === 0 && <div className={styles.emptyDeck}><b>デッキは空です</b><span>左のカードをクリックして追加します</span></div>}
            {unknownIds.map((id) => <div key={id} className={styles.unknown}>不明なカードID: {id}</div>)}
          </div>
        </aside>
      </div>

      <section className={styles.validation} aria-label="デッキ検証結果" aria-live="polite">
        <div className={styles.validationHead}>
          <strong>デッキ検証</strong>
          <span>{issues.length === 0 && unknownIds.length === 0 ? '使用条件を満たしています' : `${issues.length + unknownIds.length}件のエラー`}</span>
        </div>
        <div className={styles.validationList}>
          {unknownIds.map((id) => <p className={styles.errorIssue} key={id}>● カードプールにないIDです: {id}</p>)}
          {issues.map((issue) => <p className={styles.errorIssue} key={`${issue.code}-${issue.message}`}><span>{issue.code}</span>{issue.message}</p>)}
          {entries.length > 0 && <p className={styles.warningIssue}>▲ 収録弾情報がないカードは、版ごとのフォーマット判定を省略しています</p>}
          {dirty && <p className={styles.warningIssue}>▲ 未保存の変更があります</p>}
          {notice && <p className={styles.okIssue}>✓ {notice}</p>}
          {libraryError && <p className={styles.errorIssue}>● {libraryError}</p>}
          {importError && <p className={styles.errorIssue}>● {importError}</p>}
        </div>
      </section>
    </main>
  );
}
