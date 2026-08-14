/**
 * §6.8 操作ログパネルの確認。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import {
  applyAction,
  cardsInZone,
  type Action,
  type GameState,
  type UndoRequest,
} from '@pokeca/shared';
import { LogPanel } from './LogPanel';
import { Board } from './Board';
import { buildDemoState, DEMO_ME, DEMO_OPPONENT } from '../../cards/demoState';
import { sampleCardIndex } from '../../cards/sampleCards';

const base = buildDemoState()!;

function renderPanel(state: GameState = base, over: Partial<Parameters<typeof LogPanel>[0]> = {}) {
  const onRequestUndo = vi.fn();
  const onResolveUndo = vi.fn();
  render(
    <LogPanel
      state={state}
      cardIndex={sampleCardIndex}
      viewerId={DEMO_ME}
      onRequestUndo={onRequestUndo}
      onResolveUndo={onResolveUndo}
      {...over}
    />,
  );
  return { onRequestUndo, onResolveUndo };
}

describe('操作ログ', () => {
  it('相手の操作も含めて時系列で並ぶ', () => {
    renderPanel();
    expect(screen.getByText('操作ログ')).toBeTruthy();
    expect(screen.getByText(/デモ用のサンプル状態です/)).toBeTruthy();
    expect(screen.getAllByText(/ともだち/).length).toBeGreaterThan(0);
  });

  it('カード名をクリックすると詳細が開く', () => {
    renderPanel();
    // 場に出したカードの名前がログ行に添えられている
    const chip = screen.getAllByTitle('カードの詳細を開く')[0]!;
    const name = chip.textContent!;
    fireEvent.click(chip);

    // フル表示（見出し）が開く
    expect(screen.getByRole('heading', { name })).toBeTruthy();
  });

  it('見えないカードの名前はログに出さない', () => {
    // 相手の手札に配ったログ（drawCards）はカード名を添えない
    renderPanel();
    const rows = screen.getAllByText(/ともだちが山札を\d+枚引いた/);
    for (const row of rows) {
      expect(within(row.parentElement!).queryByTitle('カードの詳細を開く')).toBeNull();
    }
  });

  it('折りたためる', () => {
    renderPanel();
    fireEvent.click(screen.getByTitle('ログを閉じる'));
    expect(screen.queryByText(/デモ用のサンプル状態です/)).toBeNull();
  });
});

describe('取り消しの要求と承認', () => {
  it('各エントリから取り消しを要求できる', () => {
    const { onRequestUndo } = renderPanel();
    const buttons = screen.getAllByText('取消');
    fireEvent.click(buttons[buttons.length - 1]!);
    expect(onRequestUndo).toHaveBeenCalledWith(base.log[base.log.length - 1]!.seq);
  });

  it('相手からの要求には承認・却下が出る', () => {
    const pending: UndoRequest = {
      requestId: 'u12-1',
      targetSeq: 12,
      requestedBy: DEMO_OPPONENT,
      status: 'pending',
    };
    const { onResolveUndo } = renderPanel({ ...base, pendingUndo: pending });

    expect(screen.getByText(/12番以降/)).toBeTruthy();
    fireEvent.click(screen.getByText('承認して巻き戻す'));
    expect(onResolveUndo).toHaveBeenCalledWith('u12-1', true);

    fireEvent.click(screen.getByText('断る'));
    expect(onResolveUndo).toHaveBeenCalledWith('u12-1', false);
  });

  it('自分の要求には承認ボタンを出さず、返事待ちと出す', () => {
    const pending: UndoRequest = {
      requestId: 'u12-1',
      targetSeq: 12,
      requestedBy: DEMO_ME,
      status: 'pending',
    };
    renderPanel({ ...base, pendingUndo: pending });
    expect(screen.getByText('相手の返事を待っています…')).toBeTruthy();
    expect(screen.queryByText('承認して巻き戻す')).toBeNull();
  });

  it('要求中は新たな取り消しを要求できない', () => {
    renderPanel({
      ...base,
      pendingUndo: {
        requestId: 'u1-1',
        targetSeq: 1,
        requestedBy: DEMO_ME,
        status: 'pending',
      },
    });
    expect(screen.queryAllByText('取消')).toHaveLength(0);
  });

  it('取り消された操作は打ち消し線で残る', () => {
    const withUndone: GameState = {
      ...base,
      log: base.log.map((e, i) => (i === base.log.length - 1 ? { ...e, undone: true } : e)),
    };
    renderPanel(withUndone);
    const row = screen.getByText(/デモ用のサンプル状態です/).closest('div')!;
    expect(row.className).toContain('rowUndone');
    // 取り消し済みの操作には「取消」ボタンを出さない
    expect(within(row).queryByText('取消')).toBeNull();
  });
});

describe('直近の操作を盤面で光らせる（1.5秒）', () => {
  it('新しい操作が来るとハイライトが付き、1.5秒後に消える', () => {
    vi.useFakeTimers();
    try {
      const { rerender, container } = render(
        <Board state={base} viewerId={DEMO_ME} cardIndex={sampleCardIndex} />,
      );
      expect(container.querySelectorAll('[class*=recent]')).toHaveLength(0);

      // 自分のバトル場にダメカンを乗せる
      const next = applyAction(base, {
        type: 'adjustDamage',
        playerId: DEMO_ME,
        slotId: 'active',
        delta: 1,
        actorId: DEMO_ME,
        at: Date.now(),
      } as Action);

      act(() => {
        rerender(<Board state={next} viewerId={DEMO_ME} cardIndex={sampleCardIndex} />);
      });
      expect(container.querySelectorAll('[class*=recent]').length).toBeGreaterThan(0);

      act(() => {
        vi.advanceTimersByTime(1500);
      });
      expect(container.querySelectorAll('[class*=recent]')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('読み込んだ直後は光らせない', () => {
    const { container } = render(
      <Board state={base} viewerId={DEMO_ME} cardIndex={sampleCardIndex} />,
    );
    expect(container.querySelectorAll('[class*=recent]')).toHaveLength(0);
    expect(cardsInZone(base, DEMO_ME, 'hand').length).toBeGreaterThan(0);
  });
});
