import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { buildDemoState, DEMO_ME, DEMO_OPPONENT } from '../cards/demoState';
import { sampleCardIndex } from '../cards/sampleCards';
import { useGameStore } from '../net/store';
import { Table } from './Table';

const state = buildDemoState()!;

describe('対戦中の接続状態', () => {
  beforeEach(() => {
    useGameStore.setState({
      status: 'connected',
      error: null,
      roomCode: 'ROOM22',
      playerId: DEMO_ME,
      state,
      cardIndex: sampleCardIndex,
      presence: [
        { playerId: DEMO_ME, displayName: 'あなた', connected: true },
        { playerId: DEMO_OPPONENT, displayName: 'ともだち', connected: false },
      ],
    });
  });

  it('相手の切断中は操作停止の案内を盤面に重ねる', () => {
    render(<Table />);

    expect(screen.getByText('相手が切断しました')).toBeTruthy();
    expect(screen.getByText('相手が戻るまで操作を一時停止しています')).toBeTruthy();
  });

  it('自分が再接続中のときも操作停止を案内する', () => {
    useGameStore.setState({
      status: 'reconnecting',
      presence: [
        { playerId: DEMO_ME, displayName: 'あなた', connected: true },
        { playerId: DEMO_OPPONENT, displayName: 'ともだち', connected: true },
      ],
    });
    render(<Table />);

    expect(screen.getAllByText('再接続しています…').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('サーバーとの接続が戻るまで操作を一時停止しています')).toBeTruthy();
  });
});
