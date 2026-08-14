/**
 * T6 の確認用画面。2つのタブから接続して、片方の操作がもう片方に映ることを見るためのもの。
 * ちゃんとした盤面は T8 で作る。
 */
import { cardsInZone, HIDDEN_FUNCTIONAL_ID, type GameState, type PlayerId } from '@pokeca/shared';
import { useGameStore } from '../net/store';
import styles from './SyncCheck.module.css';

const ZONES = [
  ['deck', '山札'],
  ['hand', '手札'],
  ['prize', 'サイド'],
  ['discard', 'トラッシュ'],
  ['lost', 'ロスト'],
] as const;

function SeatPanel({
  state,
  playerId,
  isMe,
}: {
  state: GameState;
  playerId: PlayerId;
  isMe: boolean;
}) {
  const { cardIndex, presence, intent, dispatch } = useGameStore();
  const player = state.players[playerId];
  if (!player) return null;

  const seat = presence.find((p) => p.playerId === playerId);
  const hand = cardsInZone(state, playerId, 'hand');
  const active = player.pokemon.find((p) => p.slotId === 'active');

  const nameOf = (functionalId: string): string =>
    cardIndex?.byFunctionalId.get(functionalId)?.name ?? '？';

  return (
    <div className={`${styles.side} ${isMe ? styles.sideMine : ''}`}>
      <div className={styles.sideTitle}>
        <span>{player.displayName || playerId}</span>
        <span className={styles.tag}>{isMe ? '自分' : '相手'}</span>
        {seat && !seat.connected && <span className={styles.offline}>切断中</span>}
        {state.activePlayer === playerId && <span className={styles.tag}>手番</span>}
      </div>

      <div className={styles.counts}>
        {ZONES.map(([zone, label]) => (
          <span key={zone}>
            {label} <b>{cardsInZone(state, playerId, zone).length}</b>
          </span>
        ))}
        <span>
          サイド残 <b>{player.prizesRemaining}</b>
        </span>
        <span>
          ベンチ上限 <b>{player.benchLimit}</b>
        </span>
        <span>
          バトル場 <b>{active ? `ダメカン${active.damageCounters}` : '空'}</b>
        </span>
      </div>

      <div className={styles.hand}>
        {hand.map((card) => (
          <span
            key={card.instanceId}
            className={`${styles.handCard} ${
              card.functionalId === HIDDEN_FUNCTIONAL_ID ? styles.hidden : ''
            }`}
          >
            {card.functionalId === HIDDEN_FUNCTIONAL_ID ? '見えない' : nameOf(card.functionalId)}
          </span>
        ))}
      </div>

      {isMe && (
        <div className={styles.controls}>
          <button
            className={styles.action}
            onClick={() => intent({ type: 'devDealSampleDeck', playerId, size: 20 })}
          >
            山札を置く(20)
          </button>
          <button
            className={styles.action}
            onClick={() => intent({ type: 'shuffleDeck', playerId })}
          >
            シャッフル
          </button>
          <button
            className={styles.action}
            onClick={() => intent({ type: 'drawCards', playerId, count: 1 })}
          >
            1枚引く
          </button>
          <button
            className={styles.action}
            onClick={() => intent({ type: 'flipCoin', playerId, count: 1 })}
          >
            コイン
          </button>
          <button
            className={styles.action}
            disabled={hand.length === 0 || active !== undefined}
            onClick={() => {
              const card = hand[0];
              if (card) dispatch({ type: 'placePokemon', playerId, slotId: 'active', cardId: card.instanceId });
            }}
          >
            バトル場に出す
          </button>
          <button
            className={styles.action}
            disabled={!active}
            onClick={() => dispatch({ type: 'adjustDamage', playerId, slotId: 'active', delta: 1 })}
          >
            ダメカン +1
          </button>
          <button
            className={styles.action}
            disabled={!active}
            onClick={() => dispatch({ type: 'adjustDamage', playerId, slotId: 'active', delta: -1 })}
          >
            ダメカン −1
          </button>
        </div>
      )}
    </div>
  );
}

export function SyncCheck() {
  const { state, playerId, roomCode, status, presence, error, leave } = useGameStore();

  if (!state || !playerId) {
    return (
      <div className={styles.main}>
        <p className={styles.status}>接続中…</p>
      </div>
    );
  }

  const opponentId = Object.keys(state.players).find((id) => id !== playerId);

  return (
    <div className={styles.shell}>
      <div className={styles.main}>
        <div className={styles.header}>
          <span className={styles.roomCode}>{roomCode}</span>
          <span className={styles.status}>
            {status === 'connected' ? '接続中' : '再接続しています…'} / 在席 {presence.length}人
          </span>
          <span className={styles.spacer} />
          <button className={styles.leave} onClick={leave}>
            退出
          </button>
        </div>

        {error && <p className={styles.error}>{error}</p>}

        <p className={styles.sectionLabel}>同期の確認（T6）。盤面 UI は T8 で作ります。</p>

        {opponentId && <SeatPanel state={state} playerId={opponentId} isMe={false} />}
        <SeatPanel state={state} playerId={playerId} isMe />
      </div>

      <aside className={styles.log}>
        <div className={styles.logHead}>操作ログ</div>
        <div className={styles.logBody}>
          {state.log.map((entry) => (
            <div key={entry.seq} className={styles.logRow}>
              <span className={styles.logSeq}>{entry.seq}</span>
              <span>{entry.summary}</span>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
