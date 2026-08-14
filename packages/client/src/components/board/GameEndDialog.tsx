import { useEffect } from 'react';
import {
  detectDefeat,
  type DefeatReason,
  type GameState,
  type Intent,
  type PlayerId,
} from '@pokeca/shared';
import styles from './GameEndDialog.module.css';

const REASON_LABEL: Record<DefeatReason, string> = {
  opponentPrizes: '相手がサイドをすべて取りました',
  noPokemon: '自分の場にポケモンがいません',
  deckOut: '番の最初に山札からカードを引けませんでした',
};

export function GameEndWatch({
  state,
  viewerId,
  ready,
  intent,
}: {
  state: GameState;
  viewerId: PlayerId;
  ready: boolean;
  intent: (intent: Intent) => void;
}) {
  const localDetection = ready && !state.gameEnd ? detectDefeat(state) : null;

  useEffect(() => {
    if (localDetection && state.phase !== 'ended') intent({ type: 'detectDefeat' });
  }, [intent, localDetection?.proposalId, state.phase]);

  return (
    <>
      {state.gameEnd && (
        <GameEndDialog state={state} viewerId={viewerId} intent={intent} />
      )}
    </>
  );
}

export function GameEndDialog({
  state,
  viewerId,
  intent,
}: {
  state: GameState;
  viewerId: PlayerId;
  intent: (intent: Intent) => void;
}) {
  const proposal = state.gameEnd;
  if (!proposal) return null;

  const confirmed = proposal.confirmations[viewerId] === true;
  const allConfirmed = Object.keys(state.players).every(
    (playerId) => proposal.confirmations[playerId] === true,
  );
  const winnerName = proposal.winnerId
    ? (state.players[proposal.winnerId]?.displayName ?? proposal.winnerId)
    : null;

  return (
    <div className={styles.backdrop} role="presentation">
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-label="対戦結果の確認">
        <span className={styles.eyebrow}>勝敗条件を検出</span>
        <h2>{proposal.outcome === 'draw' ? '引き分け' : `${winnerName}の勝利`}</h2>
        <p className={styles.lead}>
          {allConfirmed
            ? '両者が結果を確認しました。対戦終了です。'
            : '自動では終了しません。内容を確認して、両者が確認ボタンを押してください。'}
        </p>

        <div className={styles.reasons}>
          {Object.entries(proposal.defeats).map(([playerId, reasons]) =>
            reasons.length > 0 ? (
              <div className={styles.playerResult} key={playerId}>
                <strong>{state.players[playerId]?.displayName ?? playerId}</strong>
                <ul>
                  {reasons.map((reason) => (
                    <li key={reason}>{REASON_LABEL[reason]}</li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
        </div>

        <div className={styles.confirmations}>
          {Object.keys(state.players).map((playerId) => (
            <span
              className={proposal.confirmations[playerId] ? styles.confirmed : styles.waiting}
              key={playerId}
            >
              {state.players[playerId]?.displayName ?? playerId}:{' '}
              {proposal.confirmations[playerId] ? '確認済み' : '確認待ち'}
            </span>
          ))}
        </div>

        <button
          type="button"
          disabled={confirmed || allConfirmed}
          onClick={() =>
            intent({ type: 'confirmGameEnd', proposalId: proposal.proposalId })
          }
        >
          {confirmed ? '確認済み' : '結果を確認する'}
        </button>
      </section>
    </div>
  );
}
