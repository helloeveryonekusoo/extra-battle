import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { applyAction, type Action, type GameState, type UnstampedAction } from '@pokeca/shared';
import { buildDemoState, DEMO_ME, DEMO_OPPONENT } from '../../cards/demoState';
import { GameEndDialog, GameEndWatch } from './GameEndDialog';

const apply = (state: GameState, action: UnstampedAction): GameState =>
  applyAction(state, { ...action, actorId: 'server', at: 1_800_000_000_000 } as Action);

function winningState() {
  let state = buildDemoState()!;
  state = apply(state, {
    type: 'setPrizes',
    playerId: DEMO_ME,
    prizesRemaining: 0,
  });
  return state;
}

describe('T18 対戦結果ダイアログ', () => {
  it('公開盤面に敗北条件があるとサーバーへ検出を依頼する', async () => {
    const intent = vi.fn();
    render(
      <GameEndWatch
        state={winningState()}
        viewerId={DEMO_ME}
        ready
        intent={intent}
      />,
    );
    await waitFor(() => expect(intent).toHaveBeenCalledWith({ type: 'detectDefeat' }));
  });

  it('勝因と両者の確認状態を表示し、自分の確認Intentを送る', () => {
    const detected = apply(winningState(), { type: 'detectDefeat' });
    const intent = vi.fn();
    render(<GameEndDialog state={detected} viewerId={DEMO_ME} intent={intent} />);

    expect(screen.getByText('あなたの勝利')).toBeTruthy();
    expect(screen.getByText('相手がサイドをすべて取りました')).toBeTruthy();
    expect(screen.getAllByText(/確認待ち/)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '結果を確認する' }));
    expect(intent).toHaveBeenCalledWith({
      type: 'confirmGameEnd',
      proposalId: detected.gameEnd!.proposalId,
    });
  });

  it('同時成立では引き分けを表示する', () => {
    let state = winningState();
    state = apply(state, {
      type: 'setPrizes',
      playerId: DEMO_OPPONENT,
      prizesRemaining: 0,
    });
    state = apply(state, { type: 'detectDefeat' });
    render(<GameEndDialog state={state} viewerId={DEMO_ME} intent={vi.fn()} />);
    expect(screen.getByRole('heading', { name: '引き分け' })).toBeTruthy();
  });
});
