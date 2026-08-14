import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  applyAction,
  createGameState,
  type Action,
  type ActionRequest,
  type GameState,
  type Intent,
  type SetupStep,
} from '@pokeca/shared';
import { SetupFlow } from './SetupFlow';
import { sampleCardIndex } from '../cards/sampleCards';

const ALICE = 'p-1';
const BOB = 'p-2';

function stateAt(step: SetupStep): GameState {
  const base = createGameState({
    gameId: 'g-setup',
    rngSeed: 'seed',
    seats: [
      { playerId: ALICE, displayName: 'アリス' },
      { playerId: BOB, displayName: 'ボブ' },
    ],
  });
  if (step === 'janken') return base;
  return applyAction(base, {
    type: 'setSetupStep',
    step,
    actorId: ALICE,
    at: 1,
  } as Action);
}

function setup(step: SetupStep, state = stateAt(step)) {
  const dispatch = vi.fn<(a: ActionRequest) => void>();
  const intent = vi.fn<(i: Intent) => void>();
  render(
    <SetupFlow
      state={state}
      viewerId={ALICE}
      cardIndex={sampleCardIndex}
      dispatch={dispatch}
      intent={intent}
      canRandomize
    />,
  );
  return { dispatch, intent };
}

describe('対戦準備の道しるべ', () => {
  it('7つの段がすべて出る', () => {
    setup('janken');
    for (const label of [
      'じゃんけん',
      '先攻・後攻を決める',
      '山札を切って7枚引く',
      'たね確認とマリガン',
      'バトル場とベンチにウラで出す',
      'サイドを置く',
      'いっせいにオモテにする',
    ]) {
      expect(screen.getAllByText(label).length, `${label} がない`).toBeGreaterThan(0);
    }
  });

  it('じゃんけんはサーバーに依頼する', () => {
    const { intent } = setup('janken');
    fireEvent.click(screen.getByText('じゃんけんをする'));
    expect(intent).toHaveBeenCalledWith({
      type: 'randomChoice',
      label: 'じゃんけん',
      options: [ALICE, BOB],
    });
  });

  it('手元でじゃんけんした結果も記録できる', () => {
    const { dispatch } = setup('janken');
    fireEvent.click(screen.getByText('ボブの勝ち'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'setJankenWinner', playerId: BOB });
  });

  it('先攻を選ぶと setFirstPlayer が飛ぶ', () => {
    const state = applyAction(stateAt('order'), {
      type: 'setJankenWinner',
      playerId: ALICE,
      actorId: ALICE,
      at: 2,
    } as Action);
    const { dispatch } = setup('order', state);
    fireEvent.click(screen.getByText('自分が先攻'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'setFirstPlayer', playerId: ALICE });
  });

  it('7枚引くはサーバー経由', () => {
    const withDeck = applyAction(stateAt('draw'), {
      type: 'setupDeck',
      playerId: ALICE,
      cards: Array.from({ length: 60 }, (_, i) => ({
        instanceId: `a-${i}`,
        functionalId: 'smpl-pikachu',
      })),
      actorId: 'server',
      at: 3,
    } as Action);
    const { intent } = setup('draw', withDeck);
    fireEvent.click(screen.getByText('7枚引く'));
    expect(intent).toHaveBeenCalledWith({ type: 'drawCards', playerId: ALICE, count: 7 });
  });

  it('マリガンの段で手札の公開と引き直しができる', () => {
    let state = applyAction(stateAt('mulligan'), {
      type: 'setupDeck',
      playerId: ALICE,
      cards: Array.from({ length: 20 }, (_, i) => ({
        instanceId: `a-${i}`,
        functionalId: 'smpl-pikachu',
      })),
      actorId: 'server',
      at: 4,
    } as Action);
    state = applyAction(state, {
      type: 'drawCards',
      playerId: ALICE,
      cardIds: ['a-0', 'a-1'],
      actorId: ALICE,
      at: 5,
    } as Action);

    const { dispatch, intent } = setup('mulligan', state);

    fireEvent.click(screen.getByText('手札を相手に見せる'));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'setCardVisibility',
      cardIds: ['a-0', 'a-1'],
      visibleTo: [ALICE, BOB],
    });

    fireEvent.click(screen.getByText('マリガン（引き直す）'));
    expect(intent).toHaveBeenCalledWith({ type: 'mulligan', playerId: ALICE, handSize: 7 });
  });

  it('★相手がマリガンしたら、追加ドローの枚数を宣言できる', () => {
    const state = applyAction(stateAt('mulligan'), {
      type: 'recordMulligan',
      playerId: BOB,
      actorId: BOB,
      at: 6,
    } as Action);
    const { dispatch } = setup('mulligan', state);

    // マリガン回数に応じて追加ドローの上限が案内される
    expect(screen.getByText(/最大 1 枚まで追加で引けます/)).toBeTruthy();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '1' } });
    fireEvent.click(screen.getByText('1枚 引くと宣言'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'declareBonusDraw', playerId: ALICE, count: 1 });
  });

  it('サイドは6枚をサーバーに置いてもらう', () => {
    const state = applyAction(stateAt('prizes'), {
      type: 'setupDeck',
      playerId: ALICE,
      cards: Array.from({ length: 20 }, (_, i) => ({
        instanceId: `a-${i}`,
        functionalId: 'smpl-pikachu',
      })),
      actorId: 'server',
      at: 7,
    } as Action);
    const { intent } = setup('prizes', state);
    fireEvent.click(screen.getByText('サイドを6枚置く'));
    expect(intent).toHaveBeenCalledWith({ type: 'dealPrizes', playerId: ALICE, count: 6 });
  });

  it('準備完了は自己申告で、両者そろうまで次へ進めない', () => {
    const { dispatch } = setup('draw');
    fireEvent.click(screen.getByText('この段を終えた'));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'setSetupReady',
      playerId: ALICE,
      ready: true,
    });
    expect(screen.getByText('次へ進む').hasAttribute('disabled')).toBe(true);
  });

  it('盤面を触るために案内を畳める', () => {
    setup('place');
    fireEvent.click(screen.getByText('盤面を操作する'));
    expect(screen.getByText('案内にもどる')).toBeTruthy();
    expect(screen.queryByText('この段を終えた')).toBeNull();
  });

  it('準備を飛ばして対戦を始められる', () => {
    const { dispatch } = setup('janken');
    fireEvent.click(screen.getByText('準備を飛ばして開始'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'setSetupStep', step: 'done' });
  });
});
