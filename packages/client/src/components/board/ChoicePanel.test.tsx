/**
 * T25 の UI（§5.1）。
 *
 * 見たいのは:
 *   - 選択中のカードだけを出す専用オーバーレイであること
 *   - 「▲▲まで」なら 0枚のまま `完了` で抜けられること
 *   - 相手には「相手が確認しています」しか出ないこと
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { cardsInZone, type ChoiceRequest, type GameState, type Op } from '@pokeca/shared';
import { buildDemoState, DEMO_ME, DEMO_OPPONENT } from '../../cards/demoState';
import { sampleCardIndex } from '../../cards/sampleCards';
import { ChoicePanel } from './ChoicePanel';

/**
 * ★このパネルはサーバーから届いた状態を描くだけの部品なので、
 *   届く形（pendingChoice が立った GameState）を直接組んで確かめる。
 *   クライアントは山札の中身を知らないので、候補はサーバーが選んで送ってくる。
 */
const CANDIDATE_OP: Op = {
  op: 'search',
  from: 'deck',
  owner: 'self',
  filter: { supertype: ['pokemon'] },
  count: 2,
  upTo: true,
  dest: 'hand',
  chooser: 'self',
  reveal: false,
  thenShuffle: true,
};

function waitingOn(choice: Partial<ChoiceRequest>, chooser = DEMO_ME): GameState {
  const base = buildDemoState()!;
  // 候補には「自分に見えているカード」を使う（一時公開されたカードと同じ扱い）
  const candidates = cardsInZone(base, DEMO_ME, 'hand')
    .slice(0, 4)
    .map((c) => c.instanceId);

  return {
    ...base,
    execution: {
      executionId: 'x1',
      ops: [CANDIDATE_OP],
      cursor: 0,
      bindings: {},
      source: { instanceId: null, playerId: chooser, label: 'ハイパーボール' },
      pendingChoice: {
        requestId: 'x1-s0',
        chooser,
        kind: 'selectCards',
        prompt: '山札から2枚まで選んでください',
        candidates,
        min: 0,
        max: 2,
        temporarilyRevealed: candidates,
        ...choice,
      },
    },
  };
}

const searchChoice = (over: Partial<ChoiceRequest> = {}) => waitingOn(over);

const renderPanel = (state: GameState, viewerId = DEMO_ME) => {
  const intent = vi.fn();
  const onCancel = vi.fn();
  render(
    <ChoicePanel
      state={state}
      viewerId={viewerId}
      cardIndex={sampleCardIndex}
      intent={intent}
      onCancel={onCancel}
    />,
  );
  return { intent, onCancel };
};

describe('選択パネル', () => {
  it('選択がなければ何も出さない', () => {
    renderPanel(buildDemoState()!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('★候補のカードだけを並べ、聞かれている内容を見出しに出す', () => {
    const state = searchChoice();
    renderPanel(state);

    const dialog = screen.getByRole('dialog', { name: 'カードを選ぶ' });
    expect(dialog).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('山札から2枚まで選んでください');

    const candidates = state.execution?.pendingChoice?.candidates ?? [];
    expect(candidates.length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(candidates.length);
  });

  it('クリックで選べて、選んだ順に番号がつく', () => {
    renderPanel(searchChoice());
    const picks = screen.getAllByRole('button', { pressed: false });

    fireEvent.click(picks[0] as HTMLElement);
    fireEvent.click(picks[1] as HTMLElement);

    // 選んだ順の番号がカードの上に出る（カウンタの数字と混ざらないよう、押されたボタン内で見る）
    const chosen = screen.getAllByRole('button', { pressed: true });
    expect(chosen).toHaveLength(2);
    expect(chosen.map((b) => b.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('1'), expect.stringContaining('2')]),
    );
  });

  it('上限を超えて選ぶと、いちばん古い選択が外れる', () => {
    renderPanel(searchChoice({ max: 2 }));
    const picks = screen.getAllByRole('button', { pressed: false });
    fireEvent.click(picks[0] as HTMLElement);
    fireEvent.click(picks[1] as HTMLElement);
    fireEvent.click(picks[2] as HTMLElement);
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(2);
  });

  it('★「▲▲まで」なら0枚のまま抜けられる', () => {
    const state = searchChoice({ min: 0 });
    const { intent } = renderPanel(state);

    const done = screen.getByRole('button', { name: '選ばずに完了' });
    expect((done as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(done);

    expect(intent).toHaveBeenCalledWith({
      type: 'resolveChoice',
      requestId: state.execution?.pendingChoice?.requestId,
      selected: [],
    });
  });

  it('「▲▲まで」でなければ、枚数が足りるまで完了できない', () => {
    const state = searchChoice({ min: 2, max: 2 });
    renderPanel(state);

    const done = screen.getByRole('button', { name: '完了' });
    expect((done as HTMLButtonElement).disabled).toBe(true);

    const picks = screen.getAllByRole('button', { pressed: false });
    fireEvent.click(picks[0] as HTMLElement);
    expect((screen.getByRole('button', { name: '完了' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(picks[1] as HTMLElement);
    expect((screen.getByRole('button', { name: '完了' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('選んだカードを requestId つきで送る', () => {
    const state = searchChoice();
    const { intent } = renderPanel(state);
    const candidates = state.execution?.pendingChoice?.candidates ?? [];

    fireEvent.click(screen.getAllByRole('button', { pressed: false })[0] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: '完了' }));

    expect(intent).toHaveBeenCalledWith({
      type: 'resolveChoice',
      requestId: state.execution?.pendingChoice?.requestId,
      selected: [candidates[0]],
    });
  });

  it('打ち切れる（自動化していない場面で卓が固まらない）', () => {
    const { onCancel } = renderPanel(searchChoice());
    fireEvent.click(screen.getByRole('button', { name: '打ち切る' }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('manual（未自動化）の確認', () => {
  it('文面を出して「確認した」で先へ進める', () => {
    const state = waitingOn({
      kind: 'confirm',
      prompt: '相手の山札を確認してください',
      candidates: [],
      min: 0,
      max: 0,
      temporarilyRevealed: [],
    });
    const { intent } = renderPanel(state);

    expect(screen.getByRole('dialog', { name: '効果の確認' })).toBeTruthy();
    expect(screen.getByText('相手の山札を確認してください')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '確認した' }));
    expect(intent).toHaveBeenCalledWith({
      type: 'resolveChoice',
      requestId: state.execution?.pendingChoice?.requestId,
      selected: [],
    });
  });
});

describe('★相手が選んでいる間', () => {
  it('候補は出さず、待っていることだけを伝える（盤面も隠さない）', () => {
    const state = searchChoice();
    // サーバーは相手には候補を空にして送る。その状態を再現する
    const asOpponentSees: GameState = {
      ...state,
      execution: state.execution
        ? {
            ...state.execution,
            pendingChoice: state.execution.pendingChoice
              ? { ...state.execution.pendingChoice, candidates: [], temporarilyRevealed: [] }
              : null,
          }
        : null,
    };

    renderPanel(asOpponentSees, DEMO_OPPONENT);

    expect(screen.queryByRole('dialog')).toBeNull();
    const bar = screen.getByRole('status');
    expect(bar.textContent).toContain('が確認しています');
    expect(bar.textContent).toContain('ハイパーボール');
  });
});
