/**
 * 対戦画面。サーバーから届いた状態をそのまま盤面に流し込み、
 * 操作はすべてサーバーへ送る（自分では状態を進めない）。
 */
import { useMemo, useState } from 'react';
import {
  findKnockoutCandidates,
  isPokemonCheckComplete,
  type ActionRequest,
  type GameState,
  type Intent,
  type PlayerId,
} from '@pokeca/shared';
import { useGameStore } from '../net/store';
import { Board } from '../components/board/Board';
import { KnockoutWatch } from '../components/board/KnockoutDialog';
import { GameEndWatch } from '../components/board/GameEndDialog';
import { DamageCalculationPanel } from '../components/board/DamageCalculationPanel';
import { TurnTrack } from '../components/board/TurnTrack';
import { ChoicePanel } from '../components/board/ChoicePanel';
import { WarningToasts } from '../components/board/WarningToasts';
import { DragProvider } from '../interaction/dnd';
import { useTableController } from '../interaction/useTableController';
import { SetupFlow } from './SetupFlow';
import { PokemonCheck } from './PokemonCheck';
import styles from './Table.module.css';

function TableInner({ state, playerId }: { state: GameState; playerId: PlayerId }) {
  const { roomCode, status, mode, isHost, presence, error, leave, cardIndex, dispatch, intent } =
    useGameStore();
  const [damagePanelOpen, setDamagePanelOpen] = useState(false);

  const opponentId = Object.keys(state.players).find((id) => id !== playerId);
  const opponentSeat = opponentId ? presence.find((p) => p.playerId === opponentId) : undefined;
  const myTurn = state.activePlayer === playerId;
  const opponentDisconnected = opponentSeat?.connected === false;
  const paused = status !== 'connected' || opponentDisconnected;

  const dispatcher = useMemo(
    () => ({
      dispatch: (action: ActionRequest) => {
        if (!paused) dispatch(action);
      },
      intent: (i: Intent) => {
        if (!paused) intent(i);
      },
      canRandomize: !paused,
    }),
    [dispatch, intent, paused],
  );

  const controller = useTableController({ state, cardIndex, viewerId: playerId, dispatcher });
  const pokemonCheckReady =
    state.phase !== 'pokemonCheck' || isPokemonCheckComplete(state);
  const gameEndReady =
    pokemonCheckReady && findKnockoutCandidates(state, { cards: cardIndex }).length === 0;

  return (
    <div className={styles.shell}>
      <div className={styles.topbar}>
        <span className={styles.roomCode}>{roomCode}</span>
        <span className={styles.status}>
          {status !== 'connected'
            ? '再接続しています…'
            : mode === 'online'
              ? `${isHost ? 'ホスト' : 'ゲスト'}・在席 ${presence.length}人`
              : `在席 ${presence.length}人`}
        </span>
        <span className={`${styles.turn} ${myTurn ? styles.turnMine : ''}`}>
          {myTurn ? 'あなたの番' : '相手の番'}
        </span>
        <TurnTrack state={state} viewerId={playerId} />
        <span className={styles.spacer} />
        <button
          className={styles.tool}
          disabled={paused || Boolean(state.setup) || state.phase === 'ended'}
          onClick={() => setDamagePanelOpen((open) => !open)}
        >
          ダメージ計算
        </button>
        <button className={`${styles.tool} ${styles.leave}`} onClick={leave}>
          退出
        </button>
      </div>

      {error && <p className={styles.error}>{error}</p>}

      {/* ★オンラインは部屋コードだけが待ち合わせの手がかり。相手が来るまで出しておく */}
      {mode === 'online' && presence.length < 2 && (
        <p className={styles.invite}>
          部屋コード <strong>{roomCode}</strong> を相手に伝えてください。相手が入ると席が配られます。
          {isHost && '（この画面を閉じると対戦は終わります）'}
        </p>
      )}

      <div className={styles.body}>
        <div className={styles.boardWrap}>
          <Board
            state={state}
            viewerId={playerId}
            cardIndex={cardIndex}
            opponentConnected={opponentSeat?.connected ?? true}
            controller={controller}
            onRequestUndo={(targetSeq) =>
              dispatcher.dispatch({ type: 'requestUndo', targetSeq })
            }
            onResolveUndo={(requestId, approve) =>
              dispatcher.intent({ type: 'resolveUndo', requestId, approve })
            }
          />
        </div>
        {damagePanelOpen && !state.setup && state.phase !== 'ended' && (
          <DamageCalculationPanel
            state={state}
            viewerId={playerId}
            cardIndex={cardIndex}
            dispatch={dispatcher.dispatch}
            onClose={() => setDamagePanelOpen(false)}
          />
        )}
      </div>

      {state.setup && (
        <SetupFlow
          state={state}
          viewerId={playerId}
          cardIndex={cardIndex}
          dispatch={dispatcher.dispatch}
          intent={dispatcher.intent}
          canRandomize={dispatcher.canRandomize}
        />
      )}

      {/* 番の終わりに自動で出る（§6.7） */}
      {!state.setup && state.phase === 'pokemonCheck' && (
        <PokemonCheck
          state={state}
          viewerId={playerId}
          cardIndex={cardIndex}
          dispatch={dispatcher.dispatch}
          intent={dispatcher.intent}
          canRandomize={dispatcher.canRandomize}
        />
      )}

      {/* ポケモンチェック中は全対象の処理後にだけきぜつを検出する（T17）。 */}
      {!state.setup && pokemonCheckReady && (
        <KnockoutWatch
          state={state}
          viewerId={playerId}
          cardIndex={cardIndex}
          intent={dispatcher.intent}
        />
        )}

      {!state.setup && (
        <GameEndWatch
          state={state}
          viewerId={playerId}
          ready={gameEndReady}
          intent={dispatcher.intent}
        />
      )}

      {/* 効果の実行中に人へ聞く場面（§5.1 / T25）。盤面より前に出す */}
      <ChoicePanel
        state={state}
        viewerId={playerId}
        cardIndex={cardIndex}
        intent={dispatcher.intent}
        onCancel={() => dispatcher.dispatch({ type: 'cancelEffect', reason: '手で処理する' })}
      />

      <WarningToasts state={state} />
      {controller.overlay}
      {paused && (
        <div className={styles.pauseOverlay} role="status" aria-live="polite">
          <div className={styles.pauseCard}>
            <strong>{opponentDisconnected ? '相手が切断しました' : '再接続しています…'}</strong>
            <span>
              {opponentDisconnected
                ? '相手が戻るまで操作を一時停止しています'
                : 'サーバーとの接続が戻るまで操作を一時停止しています'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export function Table() {
  const state = useGameStore((s) => s.state);
  const playerId = useGameStore((s) => s.playerId);

  if (!state || !playerId) {
    return (
      <div className={styles.shell}>
        <p className={styles.waiting}>接続しています…</p>
      </div>
    );
  }

  return (
    <DragProvider>
      <TableInner state={state} playerId={playerId} />
    </DragProvider>
  );
}
