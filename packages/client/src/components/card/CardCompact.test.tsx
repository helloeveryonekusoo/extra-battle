import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CardCompact } from './CardCompact';
import { hpColor } from './cardVisuals';
import { sampleCardIndex } from '../../cards/sampleCards';

const kamex = sampleCardIndex.byName.get('カメックス')![0]!; // HP180

describe('CardCompact', () => {
  it('残りHPをダメカンから出す', () => {
    render(<CardCompact card={kamex} damageCounters={7} />);
    expect(screen.getByText('110/180')).toBeTruthy();
  });

  it('ダメカン0なら満タン', () => {
    render(<CardCompact card={kamex} />);
    expect(screen.getByText('180/180')).toBeTruthy();
  });

  it('HP以上のダメカンでも負の数にしない', () => {
    render(<CardCompact card={kamex} damageCounters={30} />);
    expect(screen.getByText('0/180')).toBeTruthy();
  });

  it('どうぐと特殊状態のバッジを出す', () => {
    render(
      <CardCompact card={kamex} toolName="スピードふうせん" conditions={['poisoned', 'asleep']} />,
    );
    expect(screen.getByText(/スピードふうせん/)).toBeTruthy();
    expect(screen.getByText('どく')).toBeTruthy();
    expect(screen.getByText('ねむり')).toBeTruthy();
  });

  it('進化スタックの枚数を出す', () => {
    render(<CardCompact card={kamex} stackSize={3} />);
    expect(screen.getByText('進化 3枚')).toBeTruthy();
  });

  it('未実装カードはMANUAL、実装済みカードはAUTOと表示する', () => {
    const { rerender } = render(<CardCompact card={kamex} />);
    expect(screen.getByText('MANUAL')).toBeTruthy();

    rerender(
      <CardCompact card={{ ...kamex, effects: [{ op: 'draw', player: 'self', count: 1 }] }} />,
    );
    expect(screen.getByText('AUTO')).toBeTruthy();
  });

  it('ウラのカードは名前もHPも出さない', () => {
    const { container } = render(<CardCompact card={kamex} faceDown damageCounters={5} />);
    expect(container.textContent).toBe('非公開');
  });
});

describe('HPバーの色（§6.3 緑→黄→赤）', () => {
  it('半分より上は緑', () => {
    expect(hpColor(180, 180)).toBe('var(--hp-high)');
    expect(hpColor(100, 180)).toBe('var(--hp-high)');
  });

  it('半分以下は黄', () => {
    expect(hpColor(80, 180)).toBe('var(--hp-mid)');
  });

  it('2割以下は赤', () => {
    expect(hpColor(30, 180)).toBe('var(--hp-low)');
    expect(hpColor(0, 180)).toBe('var(--hp-low)');
  });
});
