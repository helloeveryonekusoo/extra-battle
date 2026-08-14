import { describe, expect, it } from 'vitest';
import { applyAction } from './actions';
import { createGameState } from './gameState';
import { detectDefeat } from './defeat';
import type { Action, GameState, PlayerId, PokemonInPlay, UnstampedAction } from './index';

const ALICE = 'alice';
const BOB = 'bob';

const pokemon = (owner: PlayerId): PokemonInPlay => ({
  slotId: 'active',
  stack: [`${owner}-active`],
  attachedEnergy: [],
  attachedTool: null,
  damageCounters: 0,
  conditions: [],
  placedOnTurn: 0,
  evolvedOnTurn: null,
  devolvedOnTurn: null,
  grantedAttacks: [],
  notes: '',
});

function playing(): GameState {
  const state = createGameState({
    gameId: 'defeat-test',
    rngSeed: 'seed',
    seats: [
      { playerId: ALICE, displayName: 'アリス' },
      { playerId: BOB, displayName: 'ボブ' },
    ],
  });
  state.setup = null;
  state.phase = 'turn';
  state.players[ALICE]!.pokemon = [pokemon(ALICE)];
  state.players[BOB]!.pokemon = [pokemon(BOB)];
  return state;
}

const action = (partial: UnstampedAction): Action =>
  ({ ...partial, actorId: 'server', at: 1_800_000_000_000 }) as Action;

describe('T18 敗北条件', () => {
  it('相手のサイドが0なら、その相手の勝利になる', () => {
    const state = playing();
    state.players[ALICE]!.prizesRemaining = 0;
    const result = detectDefeat(state)!;
    expect(result.outcome).toBe('winner');
    expect(result.winnerId).toBe(ALICE);
    expect(result.defeats[BOB]).toEqual(['opponentPrizes']);
  });

  it('自分の場のポケモンが0なら敗北になる', () => {
    const state = playing();
    state.players[BOB]!.pokemon = [];
    const result = detectDefeat(state)!;
    expect(result.winnerId).toBe(ALICE);
    expect(result.defeats[BOB]).toEqual(['noPokemon']);
  });

  it('山札が空なだけでは敗北せず、番開始時のドロー失敗を明示したときだけ敗北になる', () => {
    const state = playing();
    expect(detectDefeat(state)).toBeNull();
    const result = detectDefeat(state, BOB)!;
    expect(result.winnerId).toBe(ALICE);
    expect(result.defeats[BOB]).toEqual(['deckOut']);
  });

  it('両者が同時に敗北条件を満たすと引き分けになる', () => {
    const state = playing();
    state.players[ALICE]!.prizesRemaining = 0;
    state.players[BOB]!.prizesRemaining = 0;
    const result = detectDefeat(state)!;
    expect(result.outcome).toBe('draw');
    expect(result.winnerId).toBeNull();
  });

  it('検出だけでは終了せず、両者が確認して初めて ended になる', () => {
    const state = playing();
    state.players[ALICE]!.prizesRemaining = 0;
    const detected = applyAction(state, action({ type: 'detectDefeat' }));
    const proposalId = detected.gameEnd!.proposalId;
    expect(detected.phase).toBe('turn');

    const one = applyAction(
      detected,
      action({ type: 'confirmGameEnd', playerId: ALICE, proposalId }),
    );
    expect(one.phase).toBe('turn');
    expect(one.gameEnd?.confirmations[ALICE]).toBe(true);

    const both = applyAction(
      one,
      action({ type: 'confirmGameEnd', playerId: BOB, proposalId }),
    );
    expect(both.phase).toBe('ended');
  });
});
