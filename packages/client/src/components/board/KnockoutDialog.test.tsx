import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { applyAction, findSlot, type Action } from '@pokeca/shared';
import { buildDemoState, DEMO_ME } from '../../cards/demoState';
import { sampleCardIndex } from '../../cards/sampleCards';
import { KnockoutWatch } from './KnockoutDialog';

const withDamage = (counters: number) => {
  const state = buildDemoState()!;
  return applyAction(
    state,
    {
      type: 'setDamage',
      playerId: DEMO_ME,
      slotId: 'active',
      counters,
      actorId: DEMO_ME,
      at: 1_800_000_000_000,
    } satisfies Action,
    { cards: sampleCardIndex },
  );
};

describe('きぜつ確認ダイアログ', () => {
  it('HP未満では出ず、HP以上になると候補のHPとダメージを表示する', () => {
    const intent = vi.fn();
    const { rerender } = render(
      <KnockoutWatch
        state={withDamage(17)}
        viewerId={DEMO_ME}
        cardIndex={sampleCardIndex}
        intent={intent}
      />,
    );
    expect(screen.queryByRole('dialog', { name: 'きぜつの確認' })).toBeNull();

    rerender(
      <KnockoutWatch
        state={withDamage(18)}
        viewerId={DEMO_ME}
        cardIndex={sampleCardIndex}
        intent={intent}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'きぜつの確認' })).toBeTruthy();
    expect(screen.getByText('カメックス')).toBeTruthy();
    expect(screen.getByText(/180 \/ 180/)).toBeTruthy();
  });

  it('サイド枚数を手で変更でき、対象カードIDつきのIntentを送る', () => {
    const state = withDamage(18);
    const topId = findSlot(state, DEMO_ME, 'active')!.stack.at(-1)!;
    const intent = vi.fn();
    render(
      <KnockoutWatch
        state={state}
        viewerId={DEMO_ME}
        cardIndex={sampleCardIndex}
        intent={intent}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'サイドを増やす' }));
    fireEvent.click(screen.getByRole('button', { name: 'きぜつを確定' }));

    expect(intent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'knockOut',
        playerId: DEMO_ME,
        slotId: 'active',
        expectedTopInstanceId: topId,
        prizeCount: 2,
      }),
    );
  });
});
