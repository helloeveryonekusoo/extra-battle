/**
 * T41 の UI（§4.4）:
 *   - 追加の番が始まるとき、画面中央に短く「追加の番」を表示
 *   - ターン履歴でも通常の番と区別して表示
 */
import { act as reactAct, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGameState, type GameState } from '@pokeca/shared';
import { BANNER_MS, ExtraTurnBanner, currentTurnIsExtra } from './ExtraTurnBanner';
import { TurnTrack } from './TurnTrack';

const ME = 'p-1';
const THEM = 'p-2';

/** turn 番、進行中の番が追加かどうかを指定した盤面 */
function board(turn: number, extraNow: boolean): GameState {
  const base = createGameState({
    gameId: 'g-turn',
    rngSeed: 'seed',
    seats: [
      { playerId: ME, displayName: '自分' },
      { playerId: THEM, displayName: '相手' },
    ],
  });
  return {
    ...base,
    setup: null,
    phase: 'turn',
    turn,
    activePlayer: ME,
    turnQueue: [ME, THEM],
    turnQueueMeta: [
      { isExtra: extraNow, source: extraNow ? 'タイムレスGX' : null },
      { isExtra: false, source: null },
    ],
    turnHistory: [
      { turn: 1, playerId: ME, isExtra: false },
      { turn: 2, playerId: THEM, isExtra: false },
      ...(extraNow ? [{ turn, playerId: ME, isExtra: true, source: 'タイムレスGX' }] : []),
    ],
  };
}

describe('★追加の番の告知（§4.4）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('いま進行中の番が追加かどうかを見分けられる', () => {
    expect(currentTurnIsExtra(board(3, true))).toBe(true);
    expect(currentTurnIsExtra(board(3, false))).toBe(false);
  });

  it('最初の描画では出さない（番が変わった瞬間だけ）', () => {
    render(<ExtraTurnBanner state={board(3, true)} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('★追加の番に変わったら中央に出る', () => {
    const { rerender } = render(<ExtraTurnBanner state={board(2, false)} />);
    rerender(<ExtraTurnBanner state={board(3, true)} />);

    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('追加の番');
    expect(banner.textContent).toContain('自分');
    // 出どころも出す
    expect(banner.textContent).toContain('タイムレスGX');
  });

  it('通常の番に変わったときは出ない', () => {
    const { rerender } = render(<ExtraTurnBanner state={board(2, false)} />);
    rerender(<ExtraTurnBanner state={board(3, false)} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('★出しっぱなしにしない（短く消える）', () => {
    const { rerender } = render(<ExtraTurnBanner state={board(2, false)} />);
    rerender(<ExtraTurnBanner state={board(3, true)} />);
    expect(screen.getByRole('status')).toBeTruthy();

    reactAct(() => {
      vi.advanceTimersByTime(BANNER_MS + 100);
    });
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('ターン表示でも区別する（§4.4）', () => {
  it('★いま進行中の番が追加なら、その旨を出す', () => {
    render(<TurnTrack state={board(3, true)} viewerId={ME} />);
    expect(screen.getByText(/追加の番: タイムレスGX/)).toBeTruthy();
  });

  it('通常の番では出さない', () => {
    render(<TurnTrack state={board(3, false)} viewerId={ME} />);
    expect(screen.queryByText(/追加の番/)).toBeNull();
  });

  it('★履歴の丸も追加の番だけ見た目が変わる', () => {
    const { container } = render(<TurnTrack state={board(3, true)} viewerId={ME} />);
    const pips = container.querySelectorAll('[aria-label="番の履歴"] > span');
    expect(pips).toHaveLength(3);
    // 追加の番の丸だけ title に「追加」が入る
    const titles = [...pips].map((p) => p.getAttribute('title') ?? '');
    expect(titles.filter((t) => t.includes('追加'))).toHaveLength(1);
    expect(titles.at(-1)).toContain('タイムレスGX');
  });
});
