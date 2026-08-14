import type {
  DefeatReason,
  GameEndProposal,
  GameState,
  PlayerId,
} from './types';

export interface DefeatDetection {
  proposalId: string;
  outcome: 'winner' | 'draw';
  winnerId: PlayerId | null;
  defeats: Record<PlayerId, DefeatReason[]>;
}

/**
 * T18 の3敗北条件を純粋に判定する。
 * 山札が空であるだけでは敗北にしない。番の最初のドロー失敗は、
 * その瞬間を知っているサーバーが turnStartDrawFailedPlayerId で明示する。
 */
export function detectDefeat(
  state: GameState,
  turnStartDrawFailedPlayerId: PlayerId | null = null,
): DefeatDetection | null {
  const playerIds = Object.keys(state.players).sort();
  if (playerIds.length < 2 || state.setup !== null) return null;

  const defeats: Record<PlayerId, DefeatReason[]> = {};
  for (const playerId of playerIds) {
    const player = state.players[playerId];
    if (!player) continue;
    const reasons: DefeatReason[] = [];

    if (player.pokemon.length === 0) reasons.push('noPokemon');
    if (turnStartDrawFailedPlayerId === playerId) reasons.push('deckOut');
    if (
      playerIds.some(
        (opponentId) =>
          opponentId !== playerId && state.players[opponentId]?.prizesRemaining === 0,
      )
    ) {
      reasons.push('opponentPrizes');
    }
    defeats[playerId] = reasons;
  }

  const defeated = playerIds.filter((playerId) => (defeats[playerId]?.length ?? 0) > 0);
  if (defeated.length === 0) return null;

  const survivors = playerIds.filter((playerId) => !defeated.includes(playerId));
  const winnerId = defeated.length === 1 && survivors.length === 1 ? survivors[0]! : null;
  const outcome = winnerId === null ? 'draw' : 'winner';
  const fingerprint = playerIds
    .map((playerId) => `${playerId}=${(defeats[playerId] ?? []).join(',')}`)
    .join('|');

  return {
    proposalId: `${outcome}:${winnerId ?? '-'}:${fingerprint}`,
    outcome,
    winnerId,
    defeats,
  };
}

export function createGameEndProposal(detection: DefeatDetection): GameEndProposal {
  return {
    ...detection,
    defeats: Object.fromEntries(
      Object.entries(detection.defeats).map(([playerId, reasons]) => [playerId, [...reasons]]),
    ),
    confirmations: Object.fromEntries(
      Object.keys(detection.defeats).map((playerId) => [playerId, false]),
    ),
  };
}
